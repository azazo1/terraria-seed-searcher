// Package task 负责持久化搜索任务, 事务断点和跨平台工作块调度.
package task

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
)

const (
	SchemaVersion = 1
	Algorithm     = "terraria-1.4.5.8-medium-v1"
	CPUBlock      = 65536
	CUDABlock     = 400000
	// MLX 每次启动都要编译 Metal 内核, 工作块需要足够大才能摊薄固定开销.
	MLXBlock = 4000000
)

// CandidateFiles 是各后端的工作目录候选文件名.
var CandidateFiles = map[string]string{
	"cpu":  "candidates_cpu.txt",
	"cuda": "candidates_gpu2.txt",
	"mlx":  "candidates_mlx.txt",
}

// HostBackends 是主机原生后端.
var HostBackends = []string{"cpu", "cuda", "mlx"}

var scalesPattern = regexp.MustCompile(`^(?:\d+(?:\.\d*)?|\.\d+)$`)

// Parameters 是搜索参数.
type Parameters struct {
	Tol     float64  `json:"tol"`
	Offer   float64  `json:"offer"`
	Range   [2]int64 `json:"range"`
	SpawnLo int      `json:"spawn_lo"`
	SpawnHi int      `json:"spawn_hi"`
	Cols    int      `json:"cols"`
	Scales  string   `json:"scales"`
	Batch   int64    `json:"batch"`
	Device  int      `json:"device"`
}

// Defaults 与旧版工作台保持一致.
func Defaults() Parameters {
	return Parameters{Tol: .5, Offer: .55, Range: [2]int64{0, 2147483647}, SpawnLo: 3180, SpawnHi: 3220, Cols: 3400, Scales: "1.00", Batch: 400000, Device: 0}
}

// Meta 是任务元数据.
type Meta struct {
	Version     int                     `json:"version"`
	ID          string                  `json:"id"`
	Algorithm   string                  `json:"algorithm"`
	Fingerprint string                  `json:"fingerprint"`
	EngineKey   string                  `json:"engine_key"`
	Backend     string                  `json:"backend"`
	Parameters  Parameters              `json:"parameters"`
	Observation observation.Observation `json:"observation"`
	Next        int64                   `json:"next"`
	Elapsed     float64                 `json:"elapsed"`
	Matched     int64                   `json:"matched"`
	Status      string                  `json:"status"`
	Updated     float64                 `json:"updated"`
	Error       string                  `json:"error,omitempty"`
	LastBlock   string                  `json:"last_block,omitempty"`
}

// Progress 是任务列表里展示的进度.
type Progress struct {
	Status     string   `json:"status"`
	Scanned    int64    `json:"scanned"`
	Total      int64    `json:"total"`
	Elapsed    float64  `json:"elapsed"`
	Rate       *float64 `json:"rate"`
	ETA        *float64 `json:"eta"`
	Candidates int64    `json:"candidates"`
}

// Summary 是任务列表项.
type Summary struct {
	ID         string     `json:"id"`
	Backend    string     `json:"backend"`
	Updated    float64    `json:"updated"`
	Parameters Parameters `json:"parameters"`
	Next       int64      `json:"next"`
	Status     string     `json:"status"`
	Error      *string    `json:"error"`
	CanResume  bool       `json:"can_resume"`
	Compatible bool       `json:"compatible"`
	Progress   Progress   `json:"progress"`
	Version    string     `json:"version"`
}

func now() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

func fingerprint(backend, key string, settings Parameters, obs observation.Observation) string {
	payload, _ := json.Marshal([]any{Algorithm, backend, key, settings, obs})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// ParseParameters 校验并规范化前端提交的参数.
func ParseParameters(raw any) (Parameters, error) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Parameters{}, fmt.Errorf("搜索参数必须是对象.")
	}
	merged := Defaults()
	result := Parameters{}
	fields := map[string]func(any) error{
		"tol":      func(v any) error { return assignFloat(v, &result.Tol) },
		"offer":    func(v any) error { return assignFloat(v, &result.Offer) },
		"spawn_lo": func(v any) error { return assignInt(v, &result.SpawnLo) },
		"spawn_hi": func(v any) error { return assignInt(v, &result.SpawnHi) },
		"cols":     func(v any) error { return assignInt(v, &result.Cols) },
		"batch":    func(v any) error { return assignInt64(v, &result.Batch) },
		"device":   func(v any) error { return assignInt(v, &result.Device) },
		"scales": func(v any) error {
			text, ok := v.(string)
			if !ok {
				return fmt.Errorf("搜索尺度无效.")
			}
			result.Scales = text
			return nil
		},
		"range": func(v any) error {
			items, ok := v.([]any)
			if !ok || len(items) != 2 {
				return fmt.Errorf("种子范围无效.")
			}
			for index, item := range items {
				value, err := toInteger(item)
				if err != nil {
					return fmt.Errorf("种子范围无效.")
				}
				result.Range[index] = value
			}
			return nil
		},
	}
	result = merged
	for key := range object {
		if _, known := fields[key]; !known {
			return Parameters{}, fmt.Errorf("搜索参数包含未知字段.")
		}
	}
	for key, assign := range fields {
		value, present := object[key]
		if !present {
			continue
		}
		if err := assign(value); err != nil {
			return Parameters{}, err
		}
	}
	if result.Tol < .01 || result.Tol > 10 {
		return Parameters{}, fmt.Errorf("搜索参数 tol 无效.")
	}
	if result.Offer < 0 || result.Offer > 1 {
		return Parameters{}, fmt.Errorf("搜索参数 offer 无效.")
	}
	if result.SpawnLo < 0 || result.SpawnLo > 6399 || result.SpawnHi < 0 || result.SpawnHi > 6399 {
		return Parameters{}, fmt.Errorf("搜索参数 spawn_lo 或 spawn_hi 无效.")
	}
	if result.Cols < 1 || result.Cols > 6400 {
		return Parameters{}, fmt.Errorf("搜索参数 cols 无效.")
	}
	if result.Batch < 1 || result.Batch > 2147483647 {
		return Parameters{}, fmt.Errorf("搜索参数 batch 无效.")
	}
	if result.Device < -1 || result.Device > 1024 {
		return Parameters{}, fmt.Errorf("搜索参数 device 无效.")
	}
	if result.Range[0] < 0 || result.Range[0] >= result.Range[1] || result.Range[1] > 2147483647 {
		return Parameters{}, fmt.Errorf("种子范围无效.")
	}
	if !(result.SpawnLo <= result.SpawnHi && result.SpawnHi < result.Cols) {
		return Parameters{}, fmt.Errorf("出生点范围超出模拟范围.")
	}
	scales := strings.Split(result.Scales, ",")
	if len(scales) < 1 || len(scales) > 8 {
		return Parameters{}, fmt.Errorf("搜索尺度无效.")
	}
	for _, item := range scales {
		item = strings.TrimSpace(item)
		if !scalesPattern.MatchString(item) {
			return Parameters{}, fmt.Errorf("搜索尺度无效.")
		}
		value, err := strconv.ParseFloat(item, 64)
		if err != nil || value < .1 || value > 10 {
			return Parameters{}, fmt.Errorf("搜索尺度无效.")
		}
	}
	return result, nil
}

func assignFloat(value any, target *float64) error {
	parsed, ok := toFloat(value)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = parsed
	return nil
}

func assignInt(value any, target *int) error {
	parsed, err := toInteger(value)
	if err != nil || int64(int(parsed)) != parsed {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = int(parsed)
	return nil
}

func assignInt64(value any, target *int64) error {
	parsed, err := toInteger(value)
	if err != nil {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = parsed
	return nil
}

func toInteger(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return strconv.ParseInt(typed.String(), 10, 64)
	case float64:
		if typed != math.Trunc(typed) {
			return 0, fmt.Errorf("不是整数")
		}
		return int64(typed), nil
	case int:
		return int64(typed), nil
	case int64:
		return typed, nil
	}
	return 0, fmt.Errorf("不是数字")
}

func toFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

// EngineKey 计算可执行文件的哈希, 用于判断搜索器版本是否变化.
func EngineKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// WebGPUKey 由三个前端搜索文件的内容决定. fsys 的根是 web/ 目录.
func WebGPUKey(fsys fs.FS) string {
	hash := sha256.New()
	for _, name := range []string{"gpu/search.wgsl", "gpu/terrain-reference.js", "gpu/search-engine.js"} {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return ""
		}
		hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// ValidateCreate 校验观测和参数是否覆盖模拟区域.
func ValidateCreate(settings Parameters, obs observation.Observation) error {
	valid := 0
	for _, value := range obs.Heights {
		if value != observation.Missing {
			valid++
		}
	}
	if valid < 20 || len(obs.Heights) > 700 {
		return fmt.Errorf("搜索需要至少 20 个有效列和最多 700 个观测列.")
	}
	base := int64(settings.SpawnLo - obs.Marker)
	width := int64(settings.SpawnHi - settings.SpawnLo + 1)
	maximumScale := 0.0
	for _, item := range strings.Split(settings.Scales, ",") {
		value, _ := strconv.ParseFloat(strings.TrimSpace(item), 64)
		if value > maximumScale {
			maximumScale = value
		}
	}
	maximumShift := int64(math.Floor(float64(len(obs.Heights)-1)*maximumScale + .5))
	simulated := int64(settings.Cols)
	if base+width+maximumShift < simulated {
		simulated = base + width + maximumShift
	}
	if simulated <= maxInt64(0, base) {
		return fmt.Errorf("出生点范围和观测列号没有覆盖模拟区域.")
	}
	return nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// SortSummaries 按更新时间倒序排列.
func SortSummaries(items []Summary) {
	sort.Slice(items, func(i, j int) bool { return items[i].Updated > items[j].Updated })
}
