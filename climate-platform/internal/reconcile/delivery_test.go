package reconcile

import (
	"encoding/json"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

func TestGlobalSetpointsBodyExcludesZones(t *testing.T) {
	body, err := globalSetpointsBody(domain.Setpoints{
		TemperatureDayC: 24,
		Zones:           []domain.ZoneTargets{{ZoneID: "bench-a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["zones"]; ok {
		t.Error("global setpoints body must not carry zones (controller /setpoints rejects them)")
	}
	if _, ok := fields["temperature_day_c"]; !ok {
		t.Error("global field dropped")
	}
}

func TestZoneBodyExcludesZoneID(t *testing.T) {
	body, err := zoneBody(domain.ZoneTargets{
		ZoneID: "bench-a", MoistureLowThreshold: 0.3, MoistureHighThreshold: 0.6,
		DrainPeriodSecs: 600, Schedule: "06:00",
	})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["zone_id"]; ok {
		t.Error("zone body must not carry zone_id (it travels in the path)")
	}
	for _, field := range []string{"moisture_low_threshold", "moisture_high_threshold", "drain_period_secs", "schedule"} {
		if _, ok := fields[field]; !ok {
			t.Errorf("zone body missing target field %q", field)
		}
	}
}

func TestParseReportedMergesAndIgnoresStatus(t *testing.T) {
	setpoints := []byte(`{"temperature_day_c":24,"co2_target_ppm":900}`)
	// The controller's /zones response also carries live status fields, which must be ignored.
	zones := []byte(`[{"zone_id":"bench-a","moisture_low_threshold":0.3,"moisture_high_threshold":0.6,"drain_period_secs":600,"schedule":"06:00","soil_moisture_vwc":0.41,"irrigating":true,"faulted":false,"last_cycle_ts":null}]`)

	reported, err := parseReported(setpoints, zones)
	if err != nil {
		t.Fatal(err)
	}
	if reported.TemperatureDayC != 24 || reported.CO2TargetPPM != 900 {
		t.Fatalf("global setpoints not parsed: %+v", reported)
	}
	if len(reported.Zones) != 1 {
		t.Fatalf("zones = %d, want 1", len(reported.Zones))
	}
	zone := reported.Zones[0]
	if zone.ZoneID != "bench-a" || zone.MoistureLowThreshold != 0.3 || zone.Schedule != "06:00" {
		t.Fatalf("zone targets not parsed: %+v", zone)
	}
}
