package api

import "testing"

func TestDecodeSetpointsPatchRejectsUnknownField(t *testing.T) {
	_, err := decodeSetpointsPatch([]byte(`{"temperature_day_c":24,"bogus":1}`))
	if err == nil {
		t.Fatal("expected unknown top-level field to be rejected")
	}
	field, ok := unknownFieldName(err)
	if !ok || field != "bogus" {
		t.Fatalf("unknownFieldName = %q, %v; want \"bogus\", true", field, ok)
	}
}

func TestDecodeSetpointsPatchRejectsUnknownZoneField(t *testing.T) {
	_, err := decodeSetpointsPatch([]byte(`{"zones":[{"zone_id":"bench-a","bogus":1}]}`))
	if err == nil {
		t.Fatal("expected unknown nested zone field to be rejected")
	}
	field, ok := unknownFieldName(err)
	if !ok || field != "bogus" {
		t.Fatalf("unknownFieldName = %q, %v; want \"bogus\", true", field, ok)
	}
}

func TestDecodeSetpointsPatchAcceptsKnownFields(t *testing.T) {
	patch, err := decodeSetpointsPatch([]byte(`{"temperature_day_c":24,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.3}]}`))
	if err != nil {
		t.Fatalf("known-only patch should decode, got %v", err)
	}
	if patch.TemperatureDayC == nil || *patch.TemperatureDayC != 24 {
		t.Fatalf("temperature_day_c not decoded: %+v", patch)
	}
	if len(patch.Zones) != 1 || patch.Zones[0].ZoneID == nil || *patch.Zones[0].ZoneID != "bench-a" {
		t.Fatalf("zones not decoded: %+v", patch.Zones)
	}
}

func TestUnknownFieldNameIgnoresOtherErrors(t *testing.T) {
	_, err := decodeSetpointsPatch([]byte(`{not valid json`))
	if err == nil {
		t.Fatal("expected a syntax error")
	}
	if field, ok := unknownFieldName(err); ok {
		t.Fatalf("syntax error must not classify as unknown field, got %q", field)
	}
}
