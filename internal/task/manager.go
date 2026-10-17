package task

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/azazo1/terraria-seed-searcher/internal/candidate"
	"github.com/azazo1/terraria-seed-searcher/internal/observation"
	"github.com/azazo1/terraria-seed-searcher/internal/progress"
)

var taskIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var blockPattern = regexp.MustCompile(`^block-[a-f0-9]{32}$`)

// Launch 是启动或恢复任务时返回给页面的数据.
type Launch struct {
	Task        Summary                 `json:"task"`
	Observation observation.Observation `json:"observation"`
	Parameters  Parameters              `json:"parameters"`
	Rows        []candidate.Candidate   `json:"rows"`
	Matched     int64                   `json:"matched"`
	Elapsed     float64                 `json:"elapsed"`
	Owner       string                  `json:"owner"`
}

type blockState struct {
	from      int64
	to        int64
	log       string
	directory string
}

type runtimeState struct {
	lock        *TaskLock
	owner       string
	stop        chan struct{}
	stopOnce    sync.Once
	started     time.Time
	baseElapsed float64
	block       *blockState
	leaseUntil  time.Time
	blockSize   int
}

type engineEntry struct {
	modTime time.Time
	size    int64
	key     string
}

// Manager 调度所有任务.
type Manager struct {
	root        string
	binaries    map[string]string
	webgpuKey   func() string
	mu          sync.Mutex
	runtime     map[string]*runtimeState
	engineCache map[string]engineEntry
}

// NewManager 创建任务管理器.
func NewManager(root string, binaries map[string]string, webgpuKey func() string) *Manager {
	return &Manager{root: root, binaries: binaries, webgpuKey: webgpuKey, runtime: map[string]*runtimeState{}, engineCache: map[string]engineEntry{}}
}

func (m *Manager) store(id string) (Store, error) {
	if !taskIDPattern.MatchString(id) {
		return Store{}, fmt.Errorf("任务编号无效.")
	}
	return Store{Directory: filepath.Join(m.root, id)}, nil
}

func (m *Manager) engineKeyLocked(backend string) (string, error) {
	if backend == "webgpu" {
		if m.webgpuKey == nil {
			return "", nil
		}
		return m.webgpuKey(), nil
	}
	path, ok := m.binaries[backend]
	if !ok || path == "" {
		return "", fmt.Errorf("搜索器不存在, 请先编译对应后端.")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("搜索器不存在, 请先编译对应后端.")
	}
	if cached, ok := m.engineCache[backend]; ok && cached.modTime.Equal(info.ModTime()) && cached.size == info.Size() {
		return cached.key, nil
	}
	key, err := EngineKey(path)
	if err != nil {
		return "", err
	}
	m.engineCache[backend] = engineEntry{modTime: info.ModTime(), size: info.Size(), key: key}
	return key, nil
}

func (m *Manager) expireLocked() {
	nowMonotonic := time.Now()
	for id, runtime := range m.runtime {
		if runtime.leaseUntil.IsZero() || !runtime.leaseUntil.Before(nowMonotonic) {
			continue
		}
		store, err := m.store(id)
		if err == nil {
			_, _ = store.Update(func(meta *Meta) {
				meta.Status = "paused"
				meta.Error = "浏览器连接已中断, 可以从最近断点继续."
			})
		}
		_ = runtime.lock.Close()
		delete(m.runtime, id)
	}
}

// Summaries 返回按更新时间倒序的任务列表.
func (m *Manager) Summaries() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.summariesLocked()
}

func (m *Manager) summariesLocked() []Summary {
	m.expireLocked()
	result := make([]Summary, 0)
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return result
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, "trash-") {
			_ = os.RemoveAll(filepath.Join(m.root, name))
			continue
		}
		if !entry.IsDir() || !taskIDPattern.MatchString(name) {
			continue
		}
		if _, err := os.Stat(filepath.Join(m.root, name, "task.sqlite")); err != nil {
			continue
		}
		summary, err := m.summaryLocked(name)
		if err != nil {
			continue
		}
		result = append(result, summary)
	}
	SortSummaries(result)
	return result
}

func (m *Manager) summaryLocked(id string) (Summary, error) {
	store, err := m.store(id)
	if err != nil {
		return Summary{}, err
	}
	meta, err := store.Read()
	if err != nil {
		return Summary{}, err
	}
	runtime := m.runtime[id]
	var live *progress.Progress
	if runtime != nil && runtime.block != nil {
		block := runtime.block
		parsed := progress.Parse(progress.ReadTail(block.log), meta.Backend, [2]int64{block.from, block.to})
		live = &parsed
	}
	status := meta.Status
	if runtime == nil && (status == "running" || status == "stopping") {
		lock, err := Acquire(filepath.Join(store.Directory, "run.lock"))
		if err != nil {
			if status != "stopping" {
				status = "running"
			}
		} else {
			_ = lock.Close()
			status = "interrupted"
		}
	}
	elapsed := meta.Elapsed
	if runtime != nil {
		elapsed = runtime.baseElapsed + time.Since(runtime.started).Seconds()
	}
	var liveScanned int64
	if live != nil {
		liveScanned = live.Scanned
	}
	scanned := meta.Next - meta.Parameters.Range[0] + liveScanned
	total := meta.Parameters.Range[1] - meta.Parameters.Range[0]
	var rate *float64
	if scanned > 0 && elapsed > 0 {
		value := float64(scanned) / elapsed
		rate = &value
	}
	var eta *float64
	if rate != nil && status == "running" {
		value := float64(total-scanned) / *rate
		eta = &value
	}
	compatible := false
	if key, err := m.engineKeyLocked(meta.Backend); err == nil {
		compatible = meta.Algorithm == Algorithm && meta.EngineKey == key
	}
	var taskError *string
	if meta.Error != "" {
		value := meta.Error
		taskError = &value
	}
	progressStatus := status
	if status == "paused" || status == "interrupted" {
		progressStatus = "stopped"
	}
	candidates := meta.Matched
	if live != nil {
		candidates += live.Candidates
	}
	canResume := compatible && (status == "paused" || status == "interrupted" || status == "failed") && meta.Next < meta.Parameters.Range[1]
	return Summary{
		ID:         id,
		Backend:    meta.Backend,
		Updated:    meta.Updated,
		Parameters: meta.Parameters,
		Next:       meta.Next,
		Status:     status,
		Error:      taskError,
		CanResume:  canResume,
		Compatible: compatible,
		Progress: Progress{
			Status:     progressStatus,
			Scanned:    scanned,
			Total:      total,
			Elapsed:    elapsed,
			Rate:       rate,
			ETA:        eta,
			Candidates: candidates,
		},
		Version: strconv.FormatInt(meta.Next, 10) + ":" + strconv.FormatFloat(meta.Updated, 'f', -1, 64) + ":" + strconv.FormatInt(liveScanned, 10),
	}, nil
}

// Summary 返回单个任务.
func (m *Manager) Summary(id string) (Summary, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.summaryLocked(id)
}

// Busy 表示是否有任务在运行.
func (m *Manager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.busyLocked()
}

func (m *Manager) busyLocked() bool {
	for _, summary := range m.summariesLocked() {
		if summary.Status == "running" || summary.Status == "stopping" {
			return true
		}
	}
	return false
}

// Delete 删除任务目录, 运行中的任务必须先停止.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	store, err := m.store(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	if info, err := os.Stat(store.Directory); err != nil || !info.IsDir() {
		m.mu.Unlock()
		return fmt.Errorf("搜索任务不存在.")
	}
	live := false
	if summary, err := m.summaryLocked(id); err == nil {
		live = summary.Status == "running" || summary.Status == "stopping"
	}
	if live {
		m.mu.Unlock()
		return fmt.Errorf("任务正在运行, 请先停止再删除.")
	}
	guard, err := Acquire(filepath.Join(store.Directory, "run.lock"))
	if err != nil {
		m.mu.Unlock()
		return err
	}
	_ = guard.Close()
	trash := filepath.Join(m.root, "trash-"+id+"-"+randomHex(16))
	if err := os.Rename(store.Directory, trash); err != nil {
		m.mu.Unlock()
		return err
	}
	delete(m.runtime, id)
	m.mu.Unlock()
	_ = os.RemoveAll(trash)
	return nil
}

// Create 创建并启动新任务.
func (m *Manager) Create(backend string, rawParameters any, obs observation.Observation) (Launch, error) {
	if backend != "webgpu" && !contains(HostBackends, backend) {
		return Launch{}, fmt.Errorf("未知搜索后端.")
	}
	settings, err := ParseParameters(rawParameters)
	if err != nil {
		return Launch{}, err
	}
	if err := ValidateCreate(settings, obs); err != nil {
		return Launch{}, err
	}
	m.mu.Lock()
	if m.busyLocked() {
		m.mu.Unlock()
		return Launch{}, fmt.Errorf("已有搜索正在运行.")
	}
	key, err := m.engineKeyLocked(backend)
	if err != nil {
		m.mu.Unlock()
		return Launch{}, err
	}
	id := randomHex(16)
	store, _ := m.store(id)
	meta := Meta{
		Version:     SchemaVersion,
		ID:          id,
		Algorithm:   Algorithm,
		Fingerprint: fingerprint(backend, key, settings, obs),
		EngineKey:   key,
		Backend:     backend,
		Parameters:  settings,
		Observation: obs,
		Next:        settings.Range[0],
		Status:      "paused",
		Updated:     now(),
	}
	if err := store.Create(meta); err != nil {
		m.mu.Unlock()
		return Launch{}, err
	}
	launch, err := m.resumeLocked(id)
	m.mu.Unlock()
	return launch, err
}

// Resume 从安全断点继续任务.
func (m *Manager) Resume(id string) (Launch, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.resumeLocked(id)
}

func (m *Manager) resumeLocked(id string) (Launch, error) {
	if m.busyLocked() {
		return Launch{}, fmt.Errorf("已有搜索正在运行, 请先等待或停止它.")
	}
	store, err := m.store(id)
	if err != nil {
		return Launch{}, err
	}
	meta, err := store.Read()
	if err != nil {
		return Launch{}, err
	}
	if meta.Fingerprint != fingerprint(meta.Backend, meta.EngineKey, meta.Parameters, meta.Observation) {
		return Launch{}, fmt.Errorf("任务保存的输入不完整或已被修改, 请创建新任务.")
	}
	summary, err := m.summaryLocked(id)
	if err != nil {
		return Launch{}, err
	}
	if !summary.CanResume {
		return Launch{}, fmt.Errorf("任务已完成或搜索器版本发生变化, 无法继续这个任务.")
	}
	guard, err := Acquire(filepath.Join(store.Directory, "run.lock"))
	if err != nil {
		return Launch{}, err
	}
	if err := os.WriteFile(filepath.Join(store.Directory, "observed.txt"), []byte(observation.ToText(meta.Observation)), 0o644); err != nil {
		_ = guard.Close()
		return Launch{}, err
	}
	runtime := &runtimeState{lock: guard, owner: randomHex(16), stop: make(chan struct{}), started: time.Now(), baseElapsed: meta.Elapsed}
	if meta.Backend == "webgpu" {
		runtime.leaseUntil = time.Now().Add(30 * time.Second)
	}
	m.runtime[id] = runtime
	if _, err := store.Update(func(value *Meta) { value.Status = "running"; value.Error = "" }); err != nil {
		_ = guard.Close()
		delete(m.runtime, id)
		return Launch{}, err
	}
	rows, err := store.Rows(2000)
	if err != nil {
		rows = nil
	}
	updated, err := m.summaryLocked(id)
	if err != nil {
		updated = summary
	}
	launch := Launch{Task: updated, Observation: meta.Observation, Parameters: meta.Parameters, Rows: rows, Matched: meta.Matched, Elapsed: meta.Elapsed, Owner: runtime.owner}
	if meta.Backend != "webgpu" {
		go m.runNative(id, runtime)
	}
	return launch, nil
}

func (m *Manager) runNative(id string, runtime *runtimeState) {
	store, _ := m.store(id)
	defer func() {
		m.mu.Lock()
		if m.runtime[id] == runtime {
			delete(m.runtime, id)
		}
		m.mu.Unlock()
		_ = runtime.lock.Close()
	}()
	for {
		meta, err := store.Read()
		if err != nil {
			return
		}
		settings := meta.Parameters
		start := meta.Next
		end := settings.Range[1]
		if key, keyErr := m.engineKey(meta.Backend); keyErr != nil || key != meta.EngineKey {
			_, _ = store.Update(func(value *Meta) {
				value.Status = "failed"
				value.Error = "搜索器版本已变化, 已保留断点和候选, 请创建新任务."
			})
			return
		}
		if stopping(runtime) || meta.Status == "stopping" {
			_, _ = store.Update(func(value *Meta) { value.Status = "paused" })
			return
		}
		if start >= end {
			_, _ = store.Update(func(value *Meta) { value.Status = "completed" })
			return
		}
		var count int64
		switch meta.Backend {
		case "cuda":
			count = minInt64(settings.Batch, CUDABlock)
		case "mlx":
			count = MLXBlock
		default:
			count = int64(runtime.blockSize)
			if count == 0 {
				count = minInt64(128, CPUBlock)
			}
		}
		blockStarted := time.Now()
		if start+count < end {
			end = start + count
		}
		attempt := filepath.Join(store.Directory, "block-"+randomHex(16))
		if err := os.Mkdir(attempt, 0o755); err != nil {
			m.failTask(store, runtime, err)
			return
		}
		logPath := filepath.Join(attempt, "output.txt")
		logFile, err := os.Create(logPath)
		if err != nil {
			m.failTask(store, runtime, err)
			return
		}
		command := m.command(meta, start, end, filepath.Join(store.Directory, "observed.txt"))
		command.Stdout = logFile
		command.Stderr = logFile
		command.Dir = attempt
		m.mu.Lock()
		runtime.block = &blockState{from: start, to: end, log: logPath, directory: attempt}
		m.mu.Unlock()
		err = command.Run()
		_ = logFile.Close()
		if err != nil {
			m.failTask(store, runtime, fmt.Errorf("搜索进程退出码 %d. 请查看运行输出, 可以从最近断点重试.", exitCode(err)))
			return
		}
		name := CandidateFiles[meta.Backend]
		rows := candidate.ReadFile(filepath.Join(attempt, name), 500000)
		if _, err := os.Stat(filepath.Join(attempt, name)); err != nil {
			m.failTask(store, runtime, fmt.Errorf("搜索器未生成候选文件, 当前工作块未提交."))
			return
		}
		report := progress.Parse(progress.ReadTail(logPath), meta.Backend, [2]int64{start, end})
		if report.Scanned != end-start {
			m.failTask(store, runtime, fmt.Errorf("搜索器没有确认完整工作块, 当前断点保持不变."))
			return
		}
		m.mu.Lock()
		stoppingNow := stopping(runtime)
		current, _ := store.Read()
		if current.Status == "stopping" {
			stoppingNow = true
		}
		status := "running"
		if end == settings.Range[1] {
			status = "completed"
		} else if stoppingNow {
			status = "paused"
		}
		elapsed := runtime.baseElapsed + time.Since(runtime.started).Seconds()
		_, commitErr := store.Commit(start, end, rows, elapsed, report.Candidates, status, filepath.Base(attempt))
		runtime.block = nil
		if meta.Backend == "cpu" {
			seconds := time.Since(blockStarted).Seconds()
			if seconds < .001 {
				seconds = .001
			}
			runtime.blockSize = int(minInt64(CPUBlock, int64(float64(end-start)/seconds)))
			if runtime.blockSize < 1 {
				runtime.blockSize = 1
			}
		}
		m.mu.Unlock()
		if commitErr != nil {
			m.failTask(store, runtime, commitErr)
			return
		}
		if meta.LastBlock != "" && blockPattern.MatchString(meta.LastBlock) {
			_ = os.RemoveAll(filepath.Join(store.Directory, meta.LastBlock))
		}
		if status != "running" {
			return
		}
	}
}

func (m *Manager) command(meta Meta, start, end int64, observedPath string) *exec.Cmd {
	settings := meta.Parameters
	args := []string{
		observedPath,
		"--range", strconv.FormatInt(start, 10), strconv.FormatInt(end, 10),
		"--marker", strconv.Itoa(meta.Observation.Marker),
		"--tol", strconv.FormatFloat(settings.Tol, 'g', -1, 64),
		"--offer", strconv.FormatFloat(settings.Offer, 'g', -1, 64),
		"--batch", strconv.FormatInt(minInt64(settings.Batch, end-start), 10),
		"--device", strconv.Itoa(settings.Device),
		"--spawn-lo", strconv.Itoa(settings.SpawnLo),
		"--spawn-hi", strconv.Itoa(settings.SpawnHi),
		"--cols", strconv.Itoa(settings.Cols),
		"--scales", settings.Scales,
	}
	return exec.Command(m.binaries[meta.Backend], args...)
}

func (m *Manager) failTask(store Store, runtime *runtimeState, err error) {
	m.mu.Lock()
	lastBlock := ""
	if runtime.block != nil {
		lastBlock = filepath.Base(runtime.block.directory)
	}
	m.mu.Unlock()
	_, _ = store.Update(func(value *Meta) {
		value.Status = "failed"
		value.Error = err.Error()
		if lastBlock != "" {
			value.LastBlock = lastBlock
		}
	})
}

func (m *Manager) engineKey(backend string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.engineKeyLocked(backend)
}

// Stop 请求停止任务, 等待当前工作块提交.
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	summary, err := m.summaryLocked(id)
	if err != nil {
		return err
	}
	if summary.Status != "running" && summary.Status != "stopping" {
		return nil
	}
	store, _ := m.store(id)
	if _, err := store.Update(func(value *Meta) { value.Status = "stopping" }); err != nil {
		return err
	}
	if runtime := m.runtime[id]; runtime != nil {
		runtime.stopOnce.Do(func() { close(runtime.stop) })
	} else if !m.busyLocked() {
		_, _ = store.Update(func(value *Meta) { value.Status = "paused" })
	}
	return nil
}

func (m *Manager) browserOwnerLocked(id, owner string) (*runtimeState, error) {
	m.expireLocked()
	runtime := m.runtime[id]
	if runtime == nil || runtime.leaseUntil.IsZero() || runtime.owner != owner {
		return nil, fmt.Errorf("浏览器任务所有权已失效, 请从保存的断点继续.")
	}
	runtime.leaseUntil = time.Now().Add(30 * time.Second)
	return runtime, nil
}

// Heartbeat 续租浏览器任务.
func (m *Manager) Heartbeat(id, owner string) (map[string]bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	runtime, err := m.browserOwnerLocked(id, owner)
	if err != nil {
		return nil, err
	}
	return map[string]bool{"stopping": stopping(runtime)}, nil
}

// BrowserCommit 提交浏览器工作块.
func (m *Manager) BrowserCommit(id string, raw map[string]any) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	owner, _ := raw["owner"].(string)
	runtime, err := m.browserOwnerLocked(id, owner)
	if err != nil {
		return false, err
	}
	store, _ := m.store(id)
	meta, err := store.Read()
	if err != nil {
		return false, err
	}
	from, fromOK := intField(raw["from"])
	next, nextOK := intField(raw["next"])
	if !fromOK || !nextOK || from != meta.Next || !(from < next && next <= minInt64(from+512, meta.Parameters.Range[1])) {
		return false, fmt.Errorf("浏览器工作块与保存的断点不一致.")
	}
	rawRows, ok := raw["candidates"].([]any)
	if !ok || len(rawRows) > int(next-from) {
		return false, fmt.Errorf("候选工作块无效.")
	}
	scales := map[float64]bool{}
	for _, item := range strings.Split(meta.Parameters.Scales, ",") {
		value, _ := strconv.ParseFloat(strings.TrimSpace(item), 64)
		scales[value] = true
	}
	saved := make([]candidate.Candidate, 0, len(rawRows))
	seen := map[int64]bool{}
	for _, item := range rawRows {
		row, ok := item.(map[string]any)
		if !ok {
			return false, fmt.Errorf("候选种子或出生点无效.")
		}
		seed, seedOK := intField(row["seed"])
		spawn, spawnOK := intField(row["spawn"])
		if !seedOK || seed < from || seed >= next || !spawnOK || spawn < int64(meta.Parameters.SpawnLo) || spawn > int64(meta.Parameters.SpawnHi) {
			return false, fmt.Errorf("候选种子或出生点无效.")
		}
		scoreValue, scoreOK := floatField(row["score"])
		scaleValue, scaleOK := floatField(row["scale"])
		if !scoreOK || math.IsNaN(scoreValue) || math.IsInf(scoreValue, 0) || scoreValue <= 0 || scoreValue > 1 || !scaleOK || !scales[scaleValue] {
			return false, fmt.Errorf("候选评分或尺度无效.")
		}
		if seen[seed] {
			return false, fmt.Errorf("工作块包含重复候选.")
		}
		seen[seed] = true
		saved = append(saved, candidate.Candidate{Seed: seed, Spawn: spawn, Scale: scaleValue, Score: int64(math.Round(scoreValue * 10000000))})
	}
	status := "running"
	if next == meta.Parameters.Range[1] {
		status = "completed"
	} else if stopping(runtime) {
		status = "stopping"
	}
	_, err = store.Commit(from, next, saved, runtime.baseElapsed+time.Since(runtime.started).Seconds(), int64(len(saved)), status, "")
	return stopping(runtime), err
}

// BrowserFinish 结束浏览器任务.
func (m *Manager) BrowserFinish(id, owner string, failed bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	runtime, err := m.browserOwnerLocked(id, owner)
	if err != nil {
		return err
	}
	store, _ := m.store(id)
	meta, err := store.Read()
	if err != nil {
		return err
	}
	status := "paused"
	if meta.Next == meta.Parameters.Range[1] {
		status = "completed"
	} else if failed {
		status = "failed"
	}
	_, err = store.Update(func(value *Meta) {
		value.Status = status
		value.Elapsed = runtime.baseElapsed + time.Since(runtime.started).Seconds()
	})
	_ = runtime.lock.Close()
	delete(m.runtime, id)
	return err
}

// Lines 返回任务候选的文本行.
func (m *Manager) Lines(id string, limit int) ([]string, error) {
	store, err := m.store(id)
	if err != nil {
		return nil, err
	}
	saved, err := store.Rows(limit)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	runtime := m.runtime[id]
	if runtime != nil && runtime.block != nil {
		meta, err := store.Read()
		if err == nil {
			live := candidate.ReadFile(filepath.Join(runtime.block.directory, CandidateFiles[meta.Backend]), 2000)
			bySeed := map[int64]candidate.Candidate{}
			for _, row := range saved {
				bySeed[row.Seed] = row
			}
			for _, row := range live {
				bySeed[row.Seed] = row
			}
			merged := make([]candidate.Candidate, 0, len(bySeed))
			for _, row := range bySeed {
				merged = append(merged, row)
			}
			sort.Slice(merged, func(i, j int) bool {
				if merged[i].Score != merged[j].Score {
					return merged[i].Score > merged[j].Score
				}
				return merged[i].Seed < merged[j].Seed
			})
			if len(merged) > limit {
				merged = merged[:limit]
			}
			saved = merged
		}
	}
	m.mu.Unlock()
	return candidate.Lines(saved), nil
}

// Log 返回任务当前或最近工作块的日志.
func (m *Manager) Log(id string) string {
	m.mu.Lock()
	runtime := m.runtime[id]
	if runtime != nil && runtime.block != nil {
		path := runtime.block.log
		m.mu.Unlock()
		return progress.ReadTail(path)
	}
	m.mu.Unlock()
	store, err := m.store(id)
	if err != nil {
		return ""
	}
	meta, err := store.Read()
	if err != nil {
		return ""
	}
	if meta.LastBlock != "" && blockPattern.MatchString(meta.LastBlock) {
		return progress.ReadTail(filepath.Join(store.Directory, meta.LastBlock, "output.txt"))
	}
	return ""
}

func stopping(runtime *runtimeState) bool {
	select {
	case <-runtime.stop:
		return true
	default:
		return false
	}
}

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func intField(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != math.Trunc(typed) {
			return 0, false
		}
		return int64(typed), true
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case interface{ Int64() (int64, error) }:
		parsed, err := typed.Int64()
		return parsed, err == nil
	}
	return 0, false
}

func floatField(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case interface{ Float64() (float64, error) }:
		parsed, err := typed.Float64()
		return parsed, err == nil
	}
	return 0, false
}

func exitCode(err error) int {
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}
