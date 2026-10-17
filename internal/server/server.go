// Package server 提供本地工作台的 HTTP 接口与静态页面.
package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
	"github.com/azazo1/terraria-seed-searcher/internal/task"
)

// Config 是工作台的运行配置.
type Config struct {
	Root        string
	Web         fs.FS
	Searcher    string
	CPUSearcher string
	MLXSearcher string
	Version     string
}

// Server 持有页面服务需要的路径和任务管理器.
type Server struct {
	root     string
	frames   string
	data     string
	work     string
	web      fs.FS
	binaries map[string]string
	manager  *task.Manager
	version  string
	mu       sync.Mutex
}

// New 创建工作台服务.
func New(config Config) *Server {
	server := &Server{
		root:     config.Root,
		frames:   filepath.Join(config.Root, "frames"),
		data:     filepath.Join(config.Root, "data"),
		work:     filepath.Join(config.Root, "workdir"),
		web:      config.Web,
		binaries: map[string]string{"cuda": config.Searcher, "cpu": config.CPUSearcher, "mlx": config.MLXSearcher},
		version:  config.Version,
	}
	server.manager = task.NewManager(
		filepath.Join(server.work, "tasks"),
		server.binaries,
		func() string { return task.WebGPUKey(config.Web) },
	)
	server.ensureDirs()
	return server
}

func (s *Server) ensureDirs() {
	for _, path := range []string{s.frames, s.data, s.work} {
		_ = os.MkdirAll(path, 0o755)
	}
}

// Manager 暴露任务管理器, 供测试和外部状态查询使用.
func (s *Server) Manager() *task.Manager { return s.manager }

// Handler 返回完整路由.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.HandleFunc("GET /web/", s.webFile)
	mux.HandleFunc("GET /data/{name}", s.dataFile)
	mux.HandleFunc("GET /frames", s.frameList)
	mux.HandleFunc("GET /frames/{name}", s.frameFile)
	mux.HandleFunc("POST /api/upload", s.uploadFrame)
	mux.HandleFunc("POST /api/delete", s.deleteFrame)
	mux.HandleFunc("GET /api/state", s.state)
	mux.HandleFunc("GET /api/observation", s.exportObservation)
	mux.HandleFunc("POST /api/observation", s.importObservation)
	mux.HandleFunc("POST /api/frames", s.saveFrames)
	mux.HandleFunc("POST /api/marks", s.saveMarks)
	mux.HandleFunc("GET /api/sweep/log", s.sweepLog)
	mux.HandleFunc("POST /api/sweep/stop", s.sweepStop)
	mux.HandleFunc("POST /api/sweep", s.sweepUnsupported)
	mux.HandleFunc("GET /api/candidates", s.candidates)
	mux.HandleFunc("POST /api/task/start", s.taskStart)
	mux.HandleFunc("POST /api/task/resume", s.taskResume)
	mux.HandleFunc("POST /api/task/stop", s.taskStop)
	mux.HandleFunc("POST /api/task/delete", s.taskDelete)
	mux.HandleFunc("POST /api/task/heartbeat", s.taskHeartbeat)
	mux.HandleFunc("POST /api/task/commit", s.taskCommit)
	mux.HandleFunc("POST /api/task/finish", s.taskFinish)
	return mux
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.web, "index.html")
	if err != nil {
		http.Error(w, "缺少 web/index.html", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (s *Server) webFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	redirects := map[string]string{"/web/grid.html": "grid", "/web/calib.html": "calib", "/web/mark.html": "mark"}
	if tab, ok := redirects[path]; ok && r.URL.Query().Get("embedded") != "1" {
		http.Redirect(w, r, "/#"+tab, http.StatusFound)
		return
	}
	http.StripPrefix("/web/", http.FileServer(http.FS(s.web))).ServeHTTP(w, r)
}

func (s *Server) dataFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if filepath.Base(name) != name {
		s.fail(w, http.StatusForbidden, "path outside data/")
		return
	}
	s.serveFile(w, r, filepath.Join(s.data, name), "application/json; charset=utf-8")
}

func (s *Server) frameList(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(s.frames)
	if err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	s.json(w, http.StatusOK, names)
}

func (s *Server) frameFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if filepath.Base(name) != name {
		s.fail(w, http.StatusForbidden, "path outside frames/")
		return
	}
	types := map[string]string{".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}
	contentType, ok := types[strings.ToLower(filepath.Ext(name))]
	if !ok {
		contentType = "image/jpeg"
	}
	s.serveFile(w, r, filepath.Join(s.frames, name), contentType)
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, path, contentType string) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		s.fail(w, http.StatusNotFound, "not found: "+filepath.Base(path))
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

func (s *Server) uploadFrame(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		s.fail(w, http.StatusBadRequest, "缺少文件名")
		return
	}
	safe := filepath.Base(name)
	extension := strings.ToLower(filepath.Ext(safe))
	if !contains([]string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}, extension) {
		s.fail(w, http.StatusBadRequest, "不是图片: "+safe)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 128*1024*1024))
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(data) == 0 {
		s.fail(w, http.StatusBadRequest, "空文件")
		return
	}
	if err := os.WriteFile(filepath.Join(s.frames, safe), data, 0o644); err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "name": safe, "bytes": len(data)})
}

func (s *Server) deleteFrame(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		s.fail(w, http.StatusBadRequest, "缺少文件名")
		return
	}
	safe := filepath.Base(name)
	path := filepath.Join(s.frames, safe)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		s.fail(w, http.StatusNotFound, "没有这个文件: "+safe)
		return
	}
	if err := os.Remove(path); err != nil {
		s.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "deleted": safe})
}

func (s *Server) readJSON(name string, fallback any) any {
	data, err := os.ReadFile(filepath.Join(s.data, name))
	if err != nil {
		return fallback
	}
	value, err := observation.DecodeRaw(data)
	if err != nil {
		return fallback
	}
	return value
}

func (s *Server) writeJSON(name string, value any) error {
	payload, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	target := filepath.Join(s.data, name)
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

func (s *Server) json(w http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func (s *Server) fail(w http.ResponseWriter, status int, message string) {
	s.json(w, status, map[string]any{"error": message})
}

func (s *Server) sweepUnsupported(w http.ResponseWriter, r *http.Request) {
	s.fail(w, http.StatusBadRequest, "请通过任务接口启动搜索.")
}

func (s *Server) sweepStop(w http.ResponseWriter, r *http.Request) {
	s.json(w, http.StatusOK, map[string]any{"ok": true})
}

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func round1(value float64) float64 { return math.Round(value*10) / 10 }

func parseLimit(r *http.Request, fallback, maximum int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < 1 {
		return 1
	}
	if value > maximum {
		return maximum
	}
	return value
}
