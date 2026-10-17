package server

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/azazo1/terraria-seed-searcher/internal/task"
)

func (s *Server) frameNames() []string {
	entries, err := os.ReadDir(s.frames)
	if err != nil {
		return []string{}
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func (s *Server) candidatePath(backend string) string {
	if backend == "" {
		backend = "cuda"
	}
	name, ok := task.CandidateFiles[backend]
	if !ok {
		name = task.CandidateFiles["cuda"]
	}
	generated := filepath.Join(s.work, name)
	if backend == "cpu" || backend == "mlx" {
		return generated
	}
	if info, err := os.Stat(generated); err == nil && !info.IsDir() {
		return generated
	}
	return filepath.Join(s.data, "candidates.txt")
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	mark := s.readJSON("marks.json", defaultMarks())
	param := s.readJSON("param.json", nil)
	observed := s.readJSON("observed_meta.json", nil)

	columns, trees := 0, 0
	if object, ok := mark.(map[string]any); ok {
		if cols, ok := object["cols"].([]any); ok {
			columns = len(cols)
		}
		if list, ok := object["trees"].([]any); ok {
			trees = len(list)
		}
	}

	candidateBytes := map[string]int64{}
	candidateVersions := map[string]string{}
	for _, backend := range task.HostBackends {
		info, err := os.Stat(s.candidatePath(backend))
		if err != nil || info.IsDir() {
			continue
		}
		candidateBytes[backend] = info.Size()
		candidateVersions[backend] = fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
	}
	candidates := int64(0)
	if info, err := os.Stat(s.candidatePath("")); err == nil && !info.IsDir() {
		candidates = info.Size()
	}

	tasks := s.manager.Summaries()
	hostTasks := make([]task.Summary, 0, len(tasks))
	for _, item := range tasks {
		if item.Backend != "webgpu" {
			hostTasks = append(hostTasks, item)
		}
	}
	sweep := map[string]any{
		"running":            false,
		"backend":            "cuda",
		"candidate_bytes":    candidateBytes,
		"candidate_versions": candidateVersions,
		"progress":           nil,
		"elapsed":            0.0,
		"candidates":         candidates,
	}
	if len(hostTasks) > 0 {
		current := hostTasks[0]
		for _, item := range hostTasks {
			if item.Status == "running" || item.Status == "stopping" {
				current = item
				break
			}
		}
		sweep["running"] = current.Status == "running" || current.Status == "stopping"
		sweep["backend"] = current.Backend
		sweep["progress"] = current.Progress
		sweep["elapsed"] = round1(current.Progress.Elapsed)
		sweep["task_id"] = current.ID
		for _, backend := range task.HostBackends {
			for _, item := range hostTasks {
				if item.Backend == backend {
					candidateVersions[backend] = item.Version
					break
				}
			}
		}
	}

	s.json(w, http.StatusOK, map[string]any{
		"frames":             s.frameNames(),
		"param":              param,
		"marks":              map[string]any{"columns": columns, "trees": trees},
		"observed":           observed,
		"searcher_built":     fileExists(s.binaries["cuda"]),
		"cpu_searcher_built": fileExists(s.binaries["cpu"]),
		"mlx_searcher_built": fileExists(s.binaries["mlx"]),
		"searcher_paths":     s.binaries,
		"sweep":              sweep,
		"tasks":              tasks,
		"version":            s.version,
	})
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func defaultMarks() map[string]any {
	return map[string]any{"tile": 20.86, "x0": 0.0, "y0": 0.0, "cols": []any{}, "trees": []any{}}
}
