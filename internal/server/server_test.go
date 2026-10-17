package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	root := t.TempDir()
	web := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>ok</html>")}}
	instance := New(Config{
		Root:        root,
		Web:         web,
		Searcher:    filepath.Join(root, "sweep"),
		CPUSearcher: filepath.Join(root, "sweep-cpu"),
		MLXSearcher: filepath.Join(root, "sweep-mlx"),
	})
	return instance, httptest.NewServer(instance.Handler())
}

func TestStateReturnsExpectedShape(t *testing.T) {
	_, ts := newTestServer(t)
	defer ts.Close()
	response, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state map[string]any
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"frames", "param", "marks", "observed", "searcher_built", "sweep", "tasks"} {
		if _, ok := state[key]; !ok {
			t.Fatalf("state is missing %q: %+v", key, state)
		}
	}
	if state["searcher_built"] != false {
		t.Fatalf("missing binary must not be reported as built: %+v", state["searcher_built"])
	}
}

func TestObservationImportAndExport(t *testing.T) {
	_, ts := newTestServer(t)
	defer ts.Close()
	body := `{"format":"terraria-seed-searcher/observation","version":1,"heights":[0,1,2],"marker":1}`
	response, err := http.Post(ts.URL+"/api/observation", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("import status: %d", response.StatusCode)
	}
	response.Body.Close()

	exported, err := http.Get(ts.URL + "/api/observation")
	if err != nil {
		t.Fatal(err)
	}
	defer exported.Body.Close()
	var value map[string]any
	if err := json.NewDecoder(exported.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	if value["marker"] != float64(1) {
		t.Fatalf("unexpected exported observation: %+v", value)
	}
}

func TestObservationRejectsInvalidPayload(t *testing.T) {
	_, ts := newTestServer(t)
	defer ts.Close()
	response, err := http.Post(ts.URL+"/api/observation", "application/json", strings.NewReader(`{"format":"wrong"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid observation must be rejected: %d", response.StatusCode)
	}
}

func TestUploadAndDeleteFrame(t *testing.T) {
	_, ts := newTestServer(t)
	defer ts.Close()
	request, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/upload?name=%E6%B5%8B%E8%AF%95.png", strings.NewReader("image-bytes"))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("upload status: %d", response.StatusCode)
	}
	list, err := http.Get(ts.URL + "/frames")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	if err := json.NewDecoder(list.Body).Decode(&names); err != nil {
		t.Fatal(err)
	}
	list.Body.Close()
	if len(names) != 1 || names[0] != "测试.png" {
		t.Fatalf("unexpected frames: %+v", names)
	}
	request, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/delete?name=%E6%B5%8B%E8%AF%95.png", nil)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete status: %d", response.StatusCode)
	}
}
