package task

import (
	"testing"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
)

func TestParseParametersDefaults(t *testing.T) {
	raw, err := observation.DecodeRaw([]byte(`{"range":[0,1000]}`))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := ParseParameters(raw)
	if err != nil {
		t.Fatalf("ParseParameters: %v", err)
	}
	if settings.Device != 0 || settings.SpawnLo != Defaults().SpawnLo || settings.SpawnHi != Defaults().SpawnHi || settings.Cols != 3400 {
		t.Fatalf("unexpected defaults: %+v", settings)
	}
	if settings.Range != [2]int64{0, 1000} {
		t.Fatalf("unexpected range: %+v", settings.Range)
	}
}

func TestParseParametersAllDevices(t *testing.T) {
	raw, err := observation.DecodeRaw([]byte(`{"range":[0,1000],"device":-1}`))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := ParseParameters(raw)
	if err != nil {
		t.Fatalf("ParseParameters: %v", err)
	}
	if settings.Device != -1 {
		t.Fatalf("device should be -1: %+v", settings)
	}
}

func TestParseParametersRejectsUnknownField(t *testing.T) {
	raw, err := observation.DecodeRaw([]byte(`{"range":[0,1000],"unknown":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseParameters(raw); err == nil {
		t.Fatal("unknown field must be rejected")
	}
}

func TestParseParametersRejectsBadScales(t *testing.T) {
	raw, err := observation.DecodeRaw([]byte(`{"range":[0,1000],"scales":"1,20"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseParameters(raw); err == nil {
		t.Fatal("out of range scale must be rejected")
	}
}

func TestValidateCreateRequiresEnoughColumns(t *testing.T) {
	settings := Defaults()
	settings.Range = [2]int64{0, 100}
	obs := observation.Observation{Format: observation.Format, Version: observation.Version, Heights: make([]float64, 10), Marker: 0}
	if err := ValidateCreate(settings, obs); err == nil {
		t.Fatal("too few valid columns must be rejected")
	}
}

// 出生点由世界规则确定: 世界中心加减 5, 再叠加标注容差.
func TestSpawnWindow(t *testing.T) {
	cases := []struct {
		world string
		lo    int
		hi    int
	}{
		{"small", 2031, 2169},
		{"medium", 3131, 3269},
		{"large", 4131, 4269},
	}
	for _, item := range cases {
		lo, hi := SpawnWindow(item.world, LookupWorld(item.world).Width)
		if lo != item.lo || hi != item.hi {
			t.Fatalf("%s spawn window: %d..%d, want %d..%d", item.world, lo, hi, item.lo, item.hi)
		}
	}
	if lo, hi := SpawnWindow("medium", 3200); hi != 3199 || lo != 3131 {
		t.Fatalf("spawn window must stay inside cols: %d..%d", lo, hi)
	}
	if LookupWorld("").Name != "medium" || LookupWorld("weird").Name != "medium" {
		t.Fatalf("empty or unknown world must fall back to medium")
	}
}

// 三个世界尺寸的分段边界必须与 src/world-geometry.h 和 web/gpu/terrain-reference.js 一致.
func TestWorldGeometries(t *testing.T) {
	want := map[string]WorldGeometry{
		"small":  {Name: "small", Width: 4200, Height: 1200, RollLo: 1891, RollHi: 2309, PlateauLo: 2017, PlateauHi: 2183, SurfMin: 204, SurfMinEps: true, SurfBeach: 276, SurfMax: 312},
		"medium": {Name: "medium", Width: 6400, Height: 1800, RollLo: 2881, RollHi: 3520, PlateauLo: 3073, PlateauHi: 3327, SurfMin: 306, SurfMinEps: false, SurfBeach: 414, SurfMax: 468},
		"large":  {Name: "large", Width: 8400, Height: 2400, RollLo: 3781, RollHi: 4619, PlateauLo: 4033, PlateauHi: 4367, SurfMin: 408, SurfMinEps: true, SurfBeach: 552, SurfMax: 624},
	}
	for name, geometry := range want {
		if got := LookupWorld(name); got != geometry {
			t.Fatalf("%s geometry mismatch: %+v", name, got)
		}
	}
}
