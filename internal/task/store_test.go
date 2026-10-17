package task

import (
	"testing"

	"github.com/azazo1/terraria-seed-searcher/internal/candidate"
	"github.com/azazo1/terraria-seed-searcher/internal/observation"
)

func TestStoreRoundTrip(t *testing.T) {
	store := Store{Directory: t.TempDir()}
	obs := observation.Observation{Format: observation.Format, Version: observation.Version, Heights: make([]float64, 30), Marker: 10}
	meta := Meta{
		Version: SchemaVersion, ID: "a0123456789abcdef0123456789abcdef", Algorithm: Algorithm,
		Fingerprint: "fixture", EngineKey: "fixture", Backend: "cpu", Parameters: Defaults(),
		Observation: obs, Next: 0, Status: "paused", Updated: now(),
	}
	if err := store.Create(meta); err != nil {
		t.Fatalf("Create: %v", err)
	}
	read, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.ID != meta.ID || read.Parameters.Range[0] != 0 {
		t.Fatalf("unexpected meta: %+v", read)
	}
	rows := []candidate.Candidate{{Seed: 5, Spawn: 3200, Scale: 1, Score: 9000000}}
	if _, err := store.Commit(0, 10, rows, 1.5, 1, "running", "block-a0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	saved, err := store.Rows(10)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	if len(saved) != 1 || saved[0].Seed != 5 {
		t.Fatalf("unexpected rows: %+v", saved)
	}
	read, _ = store.Read()
	if read.Next != 10 || read.Matched != 1 || read.LastBlock == "" {
		t.Fatalf("unexpected committed meta: %+v", read)
	}
}

func TestStoreCommitRejectsStaleOffset(t *testing.T) {
	store := Store{Directory: t.TempDir()}
	obs := observation.Observation{Format: observation.Format, Version: observation.Version, Heights: make([]float64, 30), Marker: 10}
	meta := Meta{
		Version: SchemaVersion, ID: "b0123456789abcdef0123456789abcdef", Algorithm: Algorithm,
		Fingerprint: "fixture", EngineKey: "fixture", Backend: "cpu", Parameters: Defaults(),
		Observation: obs, Next: 0, Status: "paused", Updated: now(),
	}
	if err := store.Create(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(5, 10, nil, 1, 0, "running", ""); err == nil {
		t.Fatal("stale offset must be rejected")
	}
}
