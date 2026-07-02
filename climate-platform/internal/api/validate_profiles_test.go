package api

import (
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

func fullSetpoints() domain.Setpoints {
	return domain.Setpoints{
		TemperatureDayC: 24, TemperatureNightC: 18,
		DayStart: "06:00", DayEnd: "20:00",
		HumidityLowPct: 55, HumidityHighPct: 80, HumidityDeadbandPct: 5,
		CO2TargetPPM: 900, CO2VentInterlockThresholdPct: 20,
		VPDTargetKPa: 1.0, DLITargetMol: 17,
		Zones: []domain.ZoneTargets{
			{ZoneID: "bench-a", MoistureLowThreshold: 0.3, MoistureHighThreshold: 0.6, DrainPeriodSecs: 600, Schedule: "06:00,14:00"},
		},
	}
}

func TestValidateSetpointsAcceptsValidBundle(t *testing.T) {
	if verr := validateSetpoints(fullSetpoints()); verr != nil {
		t.Fatalf("valid bundle rejected: %+v", verr)
	}
}

func TestValidateSetpointsRejects(t *testing.T) {
	cases := map[string]func(*domain.Setpoints){
		"temperature_day_c":     func(s *domain.Setpoints) { s.TemperatureDayC = 99 },
		"co2_target_ppm":        func(s *domain.Setpoints) { s.CO2TargetPPM = 9000 },
		"day_end":               func(s *domain.Setpoints) { s.DayEnd = "05:00" },    // before day_start
		"humidity_low_pct":      func(s *domain.Setpoints) { s.HumidityLowPct = 90 }, // >= high
		"zones[0].zone_id":      func(s *domain.Setpoints) { s.Zones[0].ZoneID = "Bad_Zone" },
		"zones[0].schedule":     func(s *domain.Setpoints) { s.Zones[0].Schedule = "25:00" },
		"moisture ordering":     func(s *domain.Setpoints) { s.Zones[0].MoistureLowThreshold = 0.7 }, // >= high
		"day_start bad pattern": func(s *domain.Setpoints) { s.DayStart = "6am" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			sp := fullSetpoints()
			mutate(&sp)
			if verr := validateSetpoints(sp); verr == nil {
				t.Fatalf("%s: expected a validation error", name)
			}
		})
	}
}

func TestValidateProfile(t *testing.T) {
	valid := domain.CropProfile{
		ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []domain.ProfileStage{{Stage: "vegetative", Targets: fullSetpoints()}},
	}
	if verr := validateProfile(valid); verr != nil {
		t.Fatalf("valid profile rejected: %+v", verr)
	}

	bad := valid
	bad.ID = "Not A Slug"
	if verr := validateProfile(bad); verr == nil || verr.Field != "id" {
		t.Fatalf("bad id not caught: %+v", verr)
	}

	noStages := valid
	noStages.Stages = nil
	if verr := validateProfile(noStages); verr == nil || verr.Field != "stages" {
		t.Fatalf("missing stages not caught: %+v", verr)
	}

	dup := valid
	dup.Stages = []domain.ProfileStage{
		{Stage: "veg", Targets: fullSetpoints()},
		{Stage: "veg", Targets: fullSetpoints()},
	}
	if verr := validateProfile(dup); verr == nil {
		t.Fatal("duplicate stage not caught")
	}

	badTargets := valid
	stage := domain.ProfileStage{Stage: "veg", Targets: fullSetpoints()}
	stage.Targets.TemperatureDayC = 999
	badTargets.Stages = []domain.ProfileStage{stage}
	if verr := validateProfile(badTargets); verr == nil || verr.Field != "stages[0].targets.temperature_day_c" {
		t.Fatalf("bad stage targets not prefixed: %+v", verr)
	}
}

func TestValidateProfilePatch(t *testing.T) {
	if verr := validateProfilePatch(cropProfilePatchDTO{}); verr == nil {
		t.Fatal("empty patch should be rejected")
	}
	name := "New Name"
	if verr := validateProfilePatch(cropProfilePatchDTO{Name: &name}); verr != nil {
		t.Fatalf("valid name-only patch rejected: %+v", verr)
	}
	empty := ""
	if verr := validateProfilePatch(cropProfilePatchDTO{Name: &empty}); verr == nil {
		t.Fatal("empty name should be rejected")
	}
	if verr := validateProfilePatch(cropProfilePatchDTO{Stages: []domain.ProfileStage{}}); verr == nil {
		t.Fatal("empty stages array should be rejected")
	}
}

func TestValidateAssignmentInput(t *testing.T) {
	if verr := validateAssignmentInput(assignmentInputDTO{ProfileID: "lettuce", Stage: "vegetative"}); verr != nil {
		t.Fatalf("valid input rejected: %+v", verr)
	}
	if verr := validateAssignmentInput(assignmentInputDTO{ProfileID: "Bad Slug", Stage: "veg"}); verr == nil || verr.Field != "profile_id" {
		t.Fatalf("bad profile_id not caught: %+v", verr)
	}
	if verr := validateAssignmentInput(assignmentInputDTO{ProfileID: "lettuce", Stage: ""}); verr == nil || verr.Field != "stage" {
		t.Fatalf("empty stage not caught: %+v", verr)
	}
}
