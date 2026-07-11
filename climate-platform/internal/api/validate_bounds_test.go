package api

import (
	"strings"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

func bound(min, max float64) *domain.Bound { return &domain.Bound{Min: min, Max: max} }

func TestValidateStageBoundsAcceptsValidEnvelope(t *testing.T) {
	// Baseline (fullSetpoints) has temp_day 24, humidity_high 80, co2 900, vpd 1.0 — all inside.
	bounds := &domain.StageBounds{
		TemperatureDayC: bound(20, 28),
		HumidityHighPct: bound(70, 90),
		CO2TargetPpm:    bound(800, 1000),
		VPDTargetKpa:    bound(0.5, 1_000_000), // unbounded above: a large max is still valid
	}
	if verr := validateStageBounds(fullSetpoints(), bounds); verr != nil {
		t.Fatalf("valid envelope rejected: %+v", verr)
	}
}

func TestValidateStageBoundsNilIsValid(t *testing.T) {
	if verr := validateStageBounds(fullSetpoints(), nil); verr != nil {
		t.Fatalf("nil envelope should be valid: %+v", verr)
	}
}

func TestValidateStageBoundsRejects(t *testing.T) {
	cases := map[string]struct {
		bounds *domain.StageBounds
		field  string
	}{
		"min greater than max": {
			&domain.StageBounds{TemperatureDayC: bound(28, 20)}, "bounds.temperature_day_c",
		},
		"min below physical range": {
			&domain.StageBounds{TemperatureDayC: bound(-100, 24)}, "bounds.temperature_day_c",
		},
		"max above physical range": {
			&domain.StageBounds{HumidityHighPct: bound(70, 150)}, "bounds.humidity_high_pct",
		},
		"envelope excludes baseline target": {
			// baseline temp_day is 24; an envelope of [26,28] cannot contain it.
			&domain.StageBounds{TemperatureDayC: bound(26, 28)}, "bounds.temperature_day_c",
		},
		"co2 envelope excludes baseline": {
			// baseline co2 is 900; [800,850] cannot contain it.
			&domain.StageBounds{CO2TargetPpm: bound(800, 850)}, "bounds.co2_target_ppm",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			verr := validateStageBounds(fullSetpoints(), tc.bounds)
			if verr == nil {
				t.Fatalf("%s: expected a validation error", name)
			}
			if verr.Field != tc.field {
				t.Fatalf("%s: field = %q, want %q", name, verr.Field, tc.field)
			}
		})
	}
}

func TestValidateSetpointsWithinBounds(t *testing.T) {
	sp := fullSetpoints() // temp_day 24
	bounds := domain.StageBounds{TemperatureDayC: bound(20, 26)}

	if verr := validateSetpointsWithinBounds(sp, bounds); verr != nil {
		t.Fatalf("within-envelope bundle rejected: %+v", verr)
	}

	// Inclusive upper boundary is accepted.
	edge := sp
	edge.TemperatureDayC = 26
	if verr := validateSetpointsWithinBounds(edge, bounds); verr != nil {
		t.Fatalf("boundary value should be within envelope: %+v", verr)
	}

	// Above the envelope is rejected, naming the target field and a crop-safe bound.
	over := sp
	over.TemperatureDayC = 28
	verr := validateSetpointsWithinBounds(over, bounds)
	if verr == nil {
		t.Fatal("out-of-envelope bundle should be rejected")
	}
	if verr.Field != "temperature_day_c" || !strings.Contains(verr.Bound, "crop-safe") {
		t.Fatalf("unexpected error: field=%q bound=%q", verr.Field, verr.Bound)
	}
}

func TestValidateSetpointsWithinBoundsEmptyEnvelopeIsUnconstrained(t *testing.T) {
	// A StageBounds with no per-target bounds constrains nothing (generic physical bounds already ran).
	if verr := validateSetpointsWithinBounds(fullSetpoints(), domain.StageBounds{}); verr != nil {
		t.Fatalf("empty envelope should not constrain: %+v", verr)
	}
}

func TestValidateStageBoundsPrefixedByStageIndex(t *testing.T) {
	// A stage-level envelope error is prefixed with the stage index by validateStages.
	profile := domain.CropProfile{
		ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []domain.ProfileStage{
			{Stage: "vegetative", Targets: fullSetpoints(), Bounds: &domain.StageBounds{TemperatureDayC: bound(26, 28)}},
		},
	}
	verr := validateProfile(profile)
	if verr == nil || verr.Field != "stages[0].bounds.temperature_day_c" {
		t.Fatalf("stage-prefixed bounds error not surfaced: %+v", verr)
	}
}

func TestValidateStageBoundsAcceptsValidZoneEnvelope(t *testing.T) {
	// Baseline zone bench-a: moisture 0.3/0.6, drain 600 — all inside these bounds.
	bounds := &domain.StageBounds{Zones: &domain.ZoneBounds{
		MoistureLowThreshold:  bound(0.2, 0.4),
		MoistureHighThreshold: bound(0.5, 0.7),
		DrainPeriodSecs:       bound(300, 900),
	}}
	if verr := validateStageBounds(fullSetpoints(), bounds); verr != nil {
		t.Fatalf("valid zone envelope rejected: %+v", verr)
	}
}

func TestValidateStageBoundsRejectsZoneEnvelope(t *testing.T) {
	cases := map[string]struct {
		zones *domain.ZoneBounds
		field string
	}{
		"zone min greater than max": {
			&domain.ZoneBounds{MoistureLowThreshold: bound(0.4, 0.2)}, "bounds.zones.moisture_low_threshold",
		},
		"zone max above physical range": {
			&domain.ZoneBounds{MoistureHighThreshold: bound(0.5, 1.5)}, "bounds.zones.moisture_high_threshold",
		},
		"zone envelope excludes baseline target": {
			// baseline moisture_low is 0.3; [0.4,0.5] cannot contain it.
			&domain.ZoneBounds{MoistureLowThreshold: bound(0.4, 0.5)}, "bounds.zones.moisture_low_threshold",
		},
		"drain envelope excludes baseline": {
			// baseline drain is 600; [700,900] cannot contain it.
			&domain.ZoneBounds{DrainPeriodSecs: bound(700, 900)}, "bounds.zones.drain_period_secs",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			verr := validateStageBounds(fullSetpoints(), &domain.StageBounds{Zones: tc.zones})
			if verr == nil {
				t.Fatalf("%s: expected a validation error", name)
			}
			if verr.Field != tc.field {
				t.Fatalf("%s: field = %q, want %q", name, verr.Field, tc.field)
			}
		})
	}
}

func TestValidateSetpointsWithinBoundsZoneEnvelope(t *testing.T) {
	sp := fullSetpoints() // zone bench-a moisture_low 0.3
	bounds := domain.StageBounds{Zones: &domain.ZoneBounds{MoistureLowThreshold: bound(0.2, 0.4)}}

	if verr := validateSetpointsWithinBounds(sp, bounds); verr != nil {
		t.Fatalf("within-envelope zone rejected: %+v", verr)
	}

	// Above the zone envelope is rejected, naming the indexed zone field and a crop-safe bound.
	over := fullSetpoints()
	over.Zones[0].MoistureLowThreshold = 0.45
	verr := validateSetpointsWithinBounds(over, bounds)
	if verr == nil {
		t.Fatal("out-of-envelope zone should be rejected")
	}
	if verr.Field != "zones[0].moisture_low_threshold" || !strings.Contains(verr.Bound, "crop-safe") {
		t.Fatalf("unexpected error: field=%q bound=%q", verr.Field, verr.Bound)
	}
}
