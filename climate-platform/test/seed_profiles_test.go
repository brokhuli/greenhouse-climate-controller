//go:build integration

package test

import (
	"context"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

// standardProfileIDs are the crop profiles the seed migrations ship: 000005 creates them with
// targets, 000006 gives each stage a crop-safe envelope.
var standardProfileIDs = []string{"tomato-standard", "cucumber-standard", "lettuce-standard"}

// TestSeededStandardProfilesCarryBounds locks in that the shipped standard profiles are
// optimizer-ready out of the box: every growth stage carries a crop-safe envelope, min <= max on
// each bound, and the envelope contains the stage's own targets — the same invariant the platform
// enforces on optimizer writes (internal/api/validate_bounds.go). Without an envelope the optimizer
// holds the baseline with "no crop-safe bounds present" instead of planning (climate-optimizer
// orchestration/cycle.go), so a bounds-less seed is a silent regression this guards against.
func TestSeededStandardProfilesCarryBounds(t *testing.T) {
	ctx := context.Background()
	dsn := newTimescale(t)
	if err := store.Migrate(dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()

	for _, id := range standardProfileIDs {
		profile, found, err := st.GetProfile(ctx, id)
		if err != nil {
			t.Fatalf("get profile %s: %v", id, err)
		}
		if !found {
			t.Fatalf("standard profile %s not seeded", id)
		}
		for _, stage := range profile.Stages {
			if stage.Bounds == nil {
				t.Fatalf("%s/%s: seeded stage carries no crop-safe envelope", id, stage.Stage)
			}
			for _, f := range boundedClimateTargets(stage) {
				assertContains(t, id, stage.Stage, f.name, f.target, f.bound)
			}
			if stage.Bounds.Zones == nil {
				t.Fatalf("%s/%s: seeded stage carries no per-zone envelope", id, stage.Stage)
			}
			for _, zone := range stage.Targets.Zones {
				for _, f := range boundedZoneTargets(zone, stage.Bounds.Zones) {
					assertContains(t, id, stage.Stage+"/"+zone.ZoneID, f.name, f.target, f.bound)
				}
			}
		}
	}
}

type boundedTarget struct {
	name   string
	target float64
	bound  *domain.Bound
}

// boundedClimateTargets pairs each scalar climate target with its crop-safe bound for a stage.
func boundedClimateTargets(stage domain.ProfileStage) []boundedTarget {
	t, b := stage.Targets, stage.Bounds
	return []boundedTarget{
		{"temperature_day_c", t.TemperatureDayC, b.TemperatureDayC},
		{"temperature_night_c", t.TemperatureNightC, b.TemperatureNightC},
		{"humidity_low_pct", t.HumidityLowPct, b.HumidityLowPct},
		{"humidity_high_pct", t.HumidityHighPct, b.HumidityHighPct},
		{"humidity_deadband_pct", t.HumidityDeadbandPct, b.HumidityDeadbandPct},
		{"co2_target_ppm", float64(t.CO2TargetPPM), b.CO2TargetPpm},
		{"co2_vent_interlock_threshold_pct", t.CO2VentInterlockThresholdPct, b.CO2VentInterlockThresholdPct},
		{"vpd_target_kpa", t.VPDTargetKPa, b.VPDTargetKpa},
		{"dli_target_mol", t.DLITargetMol, b.DLITargetMol},
	}
}

// boundedZoneTargets pairs each numeric per-zone irrigation target with its crop-safe bound.
func boundedZoneTargets(zone domain.ZoneTargets, b *domain.ZoneBounds) []boundedTarget {
	return []boundedTarget{
		{"moisture_low_threshold", zone.MoistureLowThreshold, b.MoistureLowThreshold},
		{"moisture_high_threshold", zone.MoistureHighThreshold, b.MoistureHighThreshold},
		{"drain_period_secs", float64(zone.DrainPeriodSecs), b.DrainPeriodSecs},
	}
}

// assertContains fails the test unless the bound is present, well-ordered, and contains its target.
func assertContains(t *testing.T, id, stage, field string, target float64, bound *domain.Bound) {
	t.Helper()
	if bound == nil {
		t.Fatalf("%s/%s: %s has no crop-safe bound", id, stage, field)
	}
	if bound.Min > bound.Max {
		t.Fatalf("%s/%s: %s bound min %v > max %v", id, stage, field, bound.Min, bound.Max)
	}
	if target < bound.Min || target > bound.Max {
		t.Fatalf("%s/%s: %s target %v outside crop-safe [%v, %v]", id, stage, field, target, bound.Min, bound.Max)
	}
}
