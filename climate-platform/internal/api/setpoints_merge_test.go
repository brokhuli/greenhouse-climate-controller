package api

import (
	"encoding/json"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
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

func TestOverlayGlobalSetpoints(t *testing.T) {
	// Controller-reported bundle: global setpoints plus a zone the profile does not govern.
	reported := []byte(`{"temperature_day_c":24,"co2_target_ppm":800,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.3,"moisture_high_threshold":0.6,"drain_period_secs":300,"schedule":"06:00"}]}`)
	intended := domain.Setpoints{TemperatureDayC: 30, CO2TargetPPM: 1100} // intended globals differ; no zones

	out, err := overlayGlobalSetpoints(reported, intended)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		TemperatureDayC float64                      `json:"temperature_day_c"`
		CO2TargetPPM    int                          `json:"co2_target_ppm"`
		Zones           []map[string]json.RawMessage `json:"zones"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	// Global setpoints come from intended (immediate authority)...
	if got.TemperatureDayC != 30 || got.CO2TargetPPM != 1100 {
		t.Fatalf("globals not overlaid from intended: %+v", got)
	}
	// ...while the controller-reported per-zone config is kept.
	if len(got.Zones) != 1 || string(got.Zones[0]["zone_id"]) != `"bench-a"` {
		t.Fatalf("controller zone config not preserved: %+v", got.Zones)
	}
}
