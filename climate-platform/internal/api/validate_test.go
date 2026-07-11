package api

import "testing"

func fptr(v float64) *float64 { return &v }
func iptr(v int) *int         { return &v }
func sptr(v string) *string   { return &v }

func TestValidateSetpointsPatch_OK(t *testing.T) {
	patch := setpointsPatchDTO{
		TemperatureDayC: fptr(24), HumidityLowPct: fptr(50), HumidityHighPct: fptr(85),
		DayStart: sptr("06:00"), DayEnd: sptr("20:00"), CO2TargetPpm: iptr(1000),
		Zones: []zoneTargetsDTO{{ZoneID: sptr("bench-a"), MoistureLowThreshold: fptr(0.35), MoistureHighThreshold: fptr(0.55), DrainPeriodSecs: iptr(300), Schedule: sptr("06:00,14:00")}},
	}
	if verr := validateSetpointsPatch(patch); verr != nil {
		t.Fatalf("expected valid, got %+v", verr)
	}
}

func TestValidateSetpointsPatch_Bounds(t *testing.T) {
	cases := []struct {
		name  string
		patch setpointsPatchDTO
		field string
	}{
		{"temp too high", setpointsPatchDTO{TemperatureDayC: fptr(99)}, "temperature_day_c"},
		{"humidity over 100", setpointsPatchDTO{HumidityHighPct: fptr(120)}, "humidity_high_pct"},
		{"deadband over 50", setpointsPatchDTO{HumidityDeadbandPct: fptr(60)}, "humidity_deadband_pct"},
		{"co2 over 5000", setpointsPatchDTO{CO2TargetPpm: iptr(6000)}, "co2_target_ppm"},
		{"vpd negative", setpointsPatchDTO{VPDTargetKpa: fptr(-1)}, "vpd_target_kpa"},
		{"bad day_start", setpointsPatchDTO{DayStart: sptr("25:00")}, "day_start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verr := validateSetpointsPatch(tc.patch)
			if verr == nil {
				t.Fatalf("expected rejection")
			}
			if verr.Field != tc.field {
				t.Fatalf("field = %q, want %q", verr.Field, tc.field)
			}
		})
	}
}

func TestValidateSetpointsPatch_CrossField(t *testing.T) {
	if verr := validateSetpointsPatch(setpointsPatchDTO{HumidityLowPct: fptr(80), HumidityHighPct: fptr(70)}); verr == nil || verr.Field != "humidity_low_pct" {
		t.Fatalf("expected humidity_low_pct cross-field error, got %+v", verr)
	}
	if verr := validateSetpointsPatch(setpointsPatchDTO{DayStart: sptr("20:00"), DayEnd: sptr("06:00")}); verr == nil || verr.Field != "day_end" {
		t.Fatalf("expected day_end cross-field error, got %+v", verr)
	}
	zones := setpointsPatchDTO{Zones: []zoneTargetsDTO{{MoistureLowThreshold: fptr(0.8), MoistureHighThreshold: fptr(0.5)}}}
	if verr := validateSetpointsPatch(zones); verr == nil || verr.Field != "zones[0].moisture_low_threshold" {
		t.Fatalf("expected zone moisture cross-field error, got %+v", verr)
	}
}

func TestValidateScale(t *testing.T) {
	if verr := validateScale(nil); verr == nil {
		t.Fatal("nil scale should be rejected")
	}
	if verr := validateScale(fptr(0.1)); verr == nil {
		t.Fatal("0.1 below range should be rejected")
	}
	if verr := validateScale(fptr(33)); verr == nil {
		t.Fatal("33 above range should be rejected")
	}
	if verr := validateScale(fptr(2)); verr != nil {
		t.Fatalf("2.0 should be valid, got %+v", verr)
	}
	if verr := validateScale(fptr(32)); verr != nil {
		t.Fatalf("32.0 should be valid, got %+v", verr)
	}
}
