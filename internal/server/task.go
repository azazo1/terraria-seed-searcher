package server

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
)

const taskBodyLimit = 2 * 1024 * 1024

func (s *Server) decodeBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, err := s.readBody(w, r, taskBodyLimit)
	if err != nil {
		s.fail(w, http.StatusRequestEntityTooLarge, "任务请求过大.")
		return nil, false
	}
	raw, err := observation.DecodeRaw(body)
	if err != nil {
		s.fail(w, http.StatusBadRequest, "请求体不是有效的 JSON.")
		return nil, false
	}
	object, ok := raw.(map[string]any)
	if !ok {
		s.fail(w, http.StatusBadRequest, "请求体必须是 JSON 对象.")
		return nil, false
	}
	return object, true
}

func (s *Server) currentObservation() (observation.Observation, error) {
	text, err := os.ReadFile(filepath.Join(s.data, "observed.txt"))
	if err != nil {
		return observation.Observation{}, err
	}
	return observation.FromText(string(text), s.observationMarker())
}

func (s *Server) taskStart(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	if _, err := os.Stat(filepath.Join(s.data, "observed.txt")); err != nil {
		s.fail(w, http.StatusBadRequest, "还没有标注, 先完成标注")
		return
	}
	value, err := s.currentObservation()
	if err != nil {
		s.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	backend, _ := body["backend"].(string)
	if backend == "" {
		backend = "cuda"
	}
	parameters, _ := body["parameters"]
	if parameters == nil {
		parameters = map[string]any{}
	}
	launch, err := s.manager.Create(backend, parameters, value)
	if err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, launch)
}

func (s *Server) taskResume(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	launch, err := s.manager.Resume(id)
	if err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, launch)
}

func (s *Server) taskStop(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	if err := s.manager.Stop(id); err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) taskDelete(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	if err := s.manager.Delete(id); err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "deleted": id})
}

func (s *Server) taskHeartbeat(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	owner, _ := body["owner"].(string)
	result, err := s.manager.Heartbeat(id, owner)
	if err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, result)
}

func (s *Server) taskCommit(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	stopping, err := s.manager.BrowserCommit(id, body)
	if err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true, "stopping": stopping})
}

func (s *Server) taskFinish(w http.ResponseWriter, r *http.Request) {
	body, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	id, _ := body["id"].(string)
	owner, _ := body["owner"].(string)
	failed, _ := body["failed"].(bool)
	if err := s.manager.BrowserFinish(id, owner, failed); err != nil {
		s.fail(w, http.StatusConflict, err.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"ok": true})
}
