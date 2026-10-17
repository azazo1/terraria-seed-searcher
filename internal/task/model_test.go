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
	if settings.Device != 0 || settings.SpawnLo != 3180 || settings.SpawnHi != 3220 || settings.Cols != 3400 {
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
