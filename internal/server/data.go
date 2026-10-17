package server

import (
	"bufio"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
	"github.com/azazo1/terraria-seed-searcher/internal/progress"
	"github.com/azazo1/terraria-seed-searcher/internal/task"
)

func (s *Server) readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	return io.ReadAll(r.Body)
}

func (s *Server) observationMarker() int {
	if meta, ok := s.readJSON("observed_meta.json", nil).(map[string]any); ok {
		if marker, ok := intValue(meta["marker"]); ok {
			return marker
		}
	}
	if marks, ok := s.readJSON("marks.json", defaultMarks()).(map[string]any); ok {
		if marker, ok := intValue(marks["marker"]); ok {
			return marker
		}
	}
	return 141
}

func (s *Server) exportObservation(w http.ResponseWriter, r *http.Request) {
	text, err := os.ReadFile(filepath.Join(s.data, "observed.txt"))
	if err != nil {
		s.fail(w, http.StatusNotFound, "尚无最终观测数据, 请先完成标注或导入观测.")
		return
	}
	value, err := observation.FromText(string(text), s.observationMarker())
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	s.json(w, http.StatusOK, value)
}

func (s *Server) importObservation(w http.ResponseWriter, r *http.Request) {
	body, err := s.readBody(w, r, observation.MaxBytes)
	if err != nil {
		s.fail(w, http.StatusRequestEntityTooLarge, "观测文件不能超过 8 MiB.")
		return
	}
	raw, err := observation.DecodeRaw(body)
	if err != nil {
		s.fail(w, http.StatusBadRequest, "观测文件不是有效的 JSON.")
		return
	}
	value, err := observation.Validate(raw)
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	target := filepath.Join(s.data, "observed.txt")
	metaTarget := filepath.Join(s.data, "observed_meta.json")
	shapesTarget := filepath.Join(s.data, "shapes.json")
	previousText, textErr := os.ReadFile(target)
	previousMeta, metaErr := os.ReadFile(metaTarget)
	previousShapes, shapesErr := os.ReadFile(shapesTarget)
	meta := map[string]any{
		"path":      target,
		"source":    "import",
		"columns":   len(value.Heights),
		"valid":     countValid(value.Heights),
		"marker":    value.Marker,
		"step_rate": observation.Summarize(value).StepRate,
	}
	if err := writeAtomic(target, []byte(observation.ToText(value))); err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.writeJSON("observed_meta.json", meta); err != nil {
		restoreFile(target, previousText, textErr)
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.Remove(shapesTarget); err != nil && !os.IsNotExist(err) {
		restoreFile(target, previousText, textErr)
		restoreFile(metaTarget, previousMeta, metaErr)
		restoreFile(shapesTarget, previousShapes, shapesErr)
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "observed": meta})
}

func (s *Server) saveFrames(w http.ResponseWriter, r *http.Request) {
	body, err := s.readBody(w, r, 8*1024*1024)
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	raw, err := observation.DecodeRaw(body)
	if err != nil {
		s.fail(w, http.StatusBadRequest, "标定参数不是有效的 JSON.")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeJSON("param.json", raw); err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "saved": filepath.Join(s.data, "param.json")})
}

func (s *Server) saveMarks(w http.ResponseWriter, r *http.Request) {
	body, err := s.readBody(w, r, 8*1024*1024)
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	raw, err := observation.DecodeRaw(body)
	if err != nil {
		s.fail(w, http.StatusBadRequest, "标注不是有效的 JSON.")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeJSON("marks.json", raw); err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	meta, err := s.buildObserved(raw)
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if meta != nil {
		if err := s.writeJSON("observed_meta.json", meta); err != nil {
			s.fail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "observed": meta})
}

func (s *Server) buildObserved(raw any) (map[string]any, error) {
	mark, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	columns, _ := mark["cols"].([]any)
	type column struct {
		index int
		y     float64
		kind  string
	}
	filtered := make([]column, 0, len(columns))
	for _, item := range columns {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := object["t"].(string)
		if kind == "tree" {
			continue
		}
		index, indexOK := intValue(object["c"])
		y, yOK := floatValue(object["y"])
		if !indexOK || !yOK {
			continue
		}
		filtered = append(filtered, column{index: index, y: y, kind: kind})
	}
	if len(filtered) == 0 {
		for _, name := range []string{"observed.txt", "observed_meta.json", "shapes.json"} {
			if err := os.Remove(filepath.Join(s.data, name)); err != nil && !os.IsNotExist(err) {
				return nil, err
			}
		}
		return nil, nil
	}
	tile, ok := floatValue(mark["tile"])
	if !ok {
		tile = 20.86
	}
	maximum := 0
	base := filtered[0].y
	for _, item := range filtered {
		if item.index > maximum {
			maximum = item.index
		}
		if item.y < base {
			base = item.y
		}
	}
	n := maximum + 1
	values := make([]string, n)
	for index := range values {
		values[index] = "-999"
	}
	shapes := map[string]any{}
	for _, item := range columns {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		index, indexOK := intValue(object["c"])
		if !indexOK {
			continue
		}
		kind, _ := object["t"].(string)
		if kind == "" {
			kind = "block"
		}
		shapes[strconv.Itoa(index)] = kind
	}
	for _, item := range filtered {
		if item.index >= 0 && item.index < n {
			values[item.index] = strconv.FormatFloat((item.y-base)/tile, 'f', 3, 64)
		}
	}
	if err := s.writeJSON("shapes.json", map[string]any{"tile": tile, "base": base, "shapes": shapes}); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(s.data, "observed.txt"), []byte(strings.Join(values, " ")+"\n")); err != nil {
		return nil, err
	}
	valid := 0
	stepped := 0
	for _, value := range values {
		if value != "-999" {
			valid++
		}
	}
	for index := 0; index+1 < len(values); index++ {
		if values[index] == "-999" || values[index+1] == "-999" {
			continue
		}
		left, _ := strconv.ParseFloat(values[index], 64)
		right, _ := strconv.ParseFloat(values[index+1], 64)
		if abs(left-right) >= 1 {
			stepped++
		}
	}
	denominator := valid - 1
	if denominator < 1 {
		denominator = 1
	}
	marker, ok := intValue(mark["marker"])
	if !ok {
		marker = 141
	}
	return map[string]any{
		"path":      filepath.Join(s.data, "observed.txt"),
		"source":    "manual",
		"columns":   n,
		"valid":     valid,
		"marker":    marker,
		"step_rate": round1(100.0 * float64(stepped) / float64(denominator)),
	}, nil
}

func (s *Server) sweepLog(w http.ResponseWriter, r *http.Request) {
	backend := r.URL.Query().Get("backend")
	if backend == "" {
		backend = "cuda"
	}
	if !contains(append(append([]string{}, task.HostBackends...), "webgpu"), backend) {
		s.fail(w, http.StatusBadRequest, "未知搜索后端.")
		return
	}
	selected, err := s.selectedTask(backend, r.URL.Query().Get("task"))
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if selected != nil {
		text := s.manager.Log(selected.ID)
		if text == "" {
			if selected.Error != nil {
				text = *selected.Error
			} else {
				text = "等待工作块输出."
			}
		}
		s.json(w, http.StatusOK, map[string]any{"log": text})
		return
	}
	if backend == "webgpu" {
		s.json(w, http.StatusOK, map[string]any{"log": "尚无浏览器搜索任务."})
		return
	}
	text := progress.ReadTail(filepath.Join(s.work, "sweep-"+backend+".log"))
	lines := strings.Split(text, "\n")
	if len(lines) > 60 {
		lines = lines[len(lines)-60:]
	}
	s.json(w, http.StatusOK, map[string]any{"log": strings.Join(lines, "\n")})
}

func (s *Server) candidates(w http.ResponseWriter, r *http.Request) {
	backend := r.URL.Query().Get("backend")
	if backend == "" {
		backend = "cuda"
	}
	if !contains(append(append([]string{}, task.HostBackends...), "webgpu"), backend) {
		s.fail(w, http.StatusBadRequest, "未知搜索后端.")
		return
	}
	limit := parseLimit(r, 200, 2000)
	selected, err := s.selectedTask(backend, r.URL.Query().Get("task"))
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if selected != nil {
		rows, err := s.manager.Lines(selected.ID, limit)
		if err != nil {
			s.fail(w, http.StatusBadRequest, err.Error())
			return
		}
		s.json(w, http.StatusOK, map[string]any{"rows": rows, "task_id": selected.ID})
		return
	}
	if backend == "webgpu" {
		s.json(w, http.StatusOK, map[string]any{"rows": []string{}})
		return
	}
	path := s.candidatePath(backend)
	rows := []string{}
	file, err := os.Open(path)
	if err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.Contains(line, "seed=") {
				rows = append(rows, line)
			}
			if len(rows) >= 200 {
				break
			}
		}
	}
	s.json(w, http.StatusOK, map[string]any{"rows": rows})
}

func (s *Server) selectedTask(backend, id string) (*task.Summary, error) {
	if id != "" {
		value, err := s.manager.Summary(id)
		if err != nil {
			return nil, err
		}
		return &value, nil
	}
	for _, item := range s.manager.Summaries() {
		if item.Backend == backend {
			value := item
			return &value, nil
		}
	}
	return nil, nil
}

func countValid(values []float64) int {
	count := 0
	for _, value := range values {
		if value != observation.Missing {
			count++
		}
	}
	return count
}

func writeAtomic(path string, data []byte) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func restoreFile(path string, data []byte, readErr error) {
	if readErr != nil {
		_ = os.Remove(path)
		return
	}
	_ = writeAtomic(path, data)
}

func intValue(value any) (int, bool) {
	parsed, ok := toInt64(value)
	if !ok || int64(int(parsed)) != parsed {
		return 0, false
	}
	return int(parsed), true
}

func floatValue(value any) (float64, bool) {
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

func toInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int64(typed)) {
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

func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}
