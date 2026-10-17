package observation

import (
	"strings"
	"testing"
)

func TestFromTextRoundTrip(t *testing.T) {
	value, err := FromText("0 -999 1.5", 2)
	if err != nil {
		t.Fatalf("FromText: %v", err)
	}
	if value.Marker != 2 || len(value.Heights) != 3 {
		t.Fatalf("unexpected observation: %+v", value)
	}
	text := ToText(value)
	if strings.TrimSpace(text) != "0 -999 1.5" {
		t.Fatalf("ToText: %q", text)
	}
	summary := Summarize(value)
	if summary.Columns != 3 || summary.Valid != 2 || summary.Marker != 2 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
}

func TestValidateRejectsUnsupported(t *testing.T) {
	cases := []map[string]any{
		{"format": "other", "version": 1, "heights": []any{0.0}, "marker": 0},
		{"format": Format, "version": 2, "heights": []any{0.0}, "marker": 0},
		{"format": Format, "version": 1, "heights": []any{-999.0}, "marker": 0},
		{"format": Format, "version": 1, "heights": []any{}, "marker": 0},
		{"format": Format, "version": 1, "heights": []any{0.0}, "marker": 0, "extra": true},
	}
	for _, raw := range cases {
		if _, err := Validate(raw); err == nil {
			t.Fatalf("expected error for %+v", raw)
		}
	}
}
