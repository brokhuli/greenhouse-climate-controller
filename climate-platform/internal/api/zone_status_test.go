package api

import (
	"encoding/json"
	"testing"
)

func TestExtractZoneStatusParsesLiveFields(t *testing.T) {
	// /zones carries config/target fields plus live status; extractZoneStatus keeps only the live half.
	zones := []byte(`[
		{"zone_id":"bench-a","moisture_low_threshold":0.35,"moisture_high_threshold":0.55,"drain_period_secs":300,"schedule":"06:00,14:00","soil_moisture_vwc":0.41,"irrigating":true,"faulted":false,"last_cycle_ts":"2026-06-29T08:00:00.000Z"},
		{"zone_id":"bench-b","moisture_low_threshold":0.30,"moisture_high_threshold":0.50,"drain_period_secs":300,"schedule":"06:00,14:00","soil_moisture_vwc":null,"irrigating":false,"faulted":true,"last_cycle_ts":null}
	]`)

	got, err := extractZoneStatus(zones)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("zone_status = %d, want 2", len(got))
	}

	a := got[0]
	if a.ZoneID != "bench-a" || a.SoilMoistureVWC == nil || *a.SoilMoistureVWC != 0.41 {
		t.Errorf("bench-a soil_moisture_vwc = %v, want 0.41", a.SoilMoistureVWC)
	}
	if !a.Irrigating || a.Faulted {
		t.Errorf("bench-a flags wrong: irrigating=%v faulted=%v", a.Irrigating, a.Faulted)
	}
	if a.LastCycleTS == nil || *a.LastCycleTS != "2026-06-29T08:00:00.000Z" {
		t.Errorf("bench-a last_cycle_ts = %v, want timestamp", a.LastCycleTS)
	}

	// Faulted zone: null moisture and null last_cycle_ts must survive as nil pointers.
	b := got[1]
	if b.SoilMoistureVWC != nil {
		t.Errorf("bench-b soil_moisture_vwc = %v, want nil", *b.SoilMoistureVWC)
	}
	if b.LastCycleTS != nil {
		t.Errorf("bench-b last_cycle_ts = %v, want nil", *b.LastCycleTS)
	}
	if !b.Faulted {
		t.Error("bench-b should be faulted")
	}
}

func TestExtractZoneStatusEmptySerializesAsArray(t *testing.T) {
	got, err := extractZoneStatus([]byte(`[]`))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("want non-nil slice so JSON is [] not null")
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "[]" {
		t.Errorf("marshaled empty zone_status = %s, want []", raw)
	}
}
