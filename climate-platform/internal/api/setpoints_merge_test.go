package api

import (
	"encoding/json"
	"testing"
)

func TestMergeSetpointsZonesProjectsTargetsAndKeepsGlobals(t *testing.T) {
	setpoints := []byte(`{"temperature_day_c":24,"co2_target_ppm":1000}`)
	// /zones carries the targets plus live status that must be projected out.
	zones := []byte(`[{"zone_id":"bench-a","moisture_low_threshold":0.35,"moisture_high_threshold":0.55,"drain_period_secs":300,"schedule":"06:00,14:00","soil_moisture_vwc":0.41,"irrigating":false,"faulted":false,"last_cycle_ts":null}]`)

	merged, err := mergeSetpointsZones(setpoints, zones)
	if err != nil {
		t.Fatal(err)
	}

	var got struct {
		TemperatureDayC float64 `json:"temperature_day_c"`
		Zones           []map[string]json.RawMessage
	}
	if err := json.Unmarshal(merged, &got); err != nil {
		t.Fatal(err)
	}
	if got.TemperatureDayC != 24 {
		t.Errorf("global setpoint lost: temperature_day_c = %v", got.TemperatureDayC)
	}
	if len(got.Zones) != 1 {
		t.Fatalf("zones = %d, want 1", len(got.Zones))
	}
	zone := got.Zones[0]
	for _, field := range zoneTargetFields {
		if _, ok := zone[field]; !ok {
			t.Errorf("zone missing target field %q", field)
		}
	}
	for _, status := range []string{"soil_moisture_vwc", "irrigating", "faulted", "last_cycle_ts"} {
		if _, ok := zone[status]; ok {
			t.Errorf("zone status field %q should have been projected out", status)
		}
	}
}

func TestStripZones(t *testing.T) {
	stripped, err := stripZones([]byte(`{"temperature_day_c":23,"zones":[{"zone_id":"bench-a"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(stripped, &obj); err != nil {
		t.Fatal(err)
	}
	if _, ok := obj["zones"]; ok {
		t.Error("zones not stripped from relay body")
	}
	if _, ok := obj["temperature_day_c"]; !ok {
		t.Error("global field dropped while stripping zones")
	}

	// No zones → original bytes returned unchanged.
	raw := []byte(`{"temperature_day_c":23}`)
	passthrough, err := stripZones(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(passthrough) != string(raw) {
		t.Errorf("expected passthrough, got %s", passthrough)
	}
}
