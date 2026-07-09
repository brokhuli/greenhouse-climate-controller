package api

import (
	"fmt"
	"strings"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// validateSetpoints checks a full (resolved or merged) setpoint bundle: every field's bounds
// plus the cross-field invariants the JSON Schema cannot express (day_end > day_start,
// humidity_low < humidity_high, per-zone moisture_low < moisture_high). It runs on the
// completed bundle a crop-profile stage carries and on the candidate an operator edit produces.
func validateSetpoints(setpoints domain.Setpoints) *valError {
	checks := []*valError{
		rangeF("temperature_day_c", &setpoints.TemperatureDayC, physTempMinC, physTempMaxC),
		rangeF("temperature_night_c", &setpoints.TemperatureNightC, physTempMinC, physTempMaxC),
		rangeF("humidity_low_pct", &setpoints.HumidityLowPct, physPctMin, physPctMax),
		rangeF("humidity_high_pct", &setpoints.HumidityHighPct, physPctMin, physPctMax),
		rangeF("humidity_deadband_pct", &setpoints.HumidityDeadbandPct, physPctMin, physDeadbandMaxPct),
		rangeI("co2_target_ppm", &setpoints.CO2TargetPPM, physCO2MinPpm, physCO2MaxPpm),
		rangeF("co2_vent_interlock_threshold_pct", &setpoints.CO2VentInterlockThresholdPct, physPctMin, physPctMax),
		minF("vpd_target_kpa", &setpoints.VPDTargetKPa, 0),
		minF("dli_target_mol", &setpoints.DLITargetMol, 0),
	}
	for _, check := range checks {
		if check != nil {
			return check
		}
	}
	if verr := pattern("day_start", setpoints.DayStart, hhmmRe); verr != nil {
		return verr
	}
	if verr := pattern("day_end", setpoints.DayEnd, hhmmRe); verr != nil {
		return verr
	}
	start, _ := minutesOfDay(setpoints.DayStart)
	end, _ := minutesOfDay(setpoints.DayEnd)
	if end <= start {
		return &valError{Field: "day_end", Bound: "must be after day_start", Value: setpoints.DayEnd}
	}
	if setpoints.HumidityLowPct >= setpoints.HumidityHighPct {
		return &valError{Field: "humidity_low_pct", Bound: "must be < humidity_high_pct", Value: setpoints.HumidityLowPct}
	}
	for index, zone := range setpoints.Zones {
		if verr := validateZoneTargets(index, zone); verr != nil {
			return verr
		}
	}
	return nil
}

func validateZoneTargets(index int, zone domain.ZoneTargets) *valError {
	prefix := fmt.Sprintf("zones[%d].", index)
	if !domain.ValidSlug(zone.ZoneID) {
		return &valError{Field: prefix + "zone_id", Bound: "lowercase kebab slug", Value: zone.ZoneID}
	}
	if verr := rangeF(prefix+"moisture_low_threshold", &zone.MoistureLowThreshold, 0, 1); verr != nil {
		return verr
	}
	if verr := rangeF(prefix+"moisture_high_threshold", &zone.MoistureHighThreshold, 0, 1); verr != nil {
		return verr
	}
	if zone.MoistureLowThreshold >= zone.MoistureHighThreshold {
		return &valError{Field: prefix + "moisture_low_threshold", Bound: "must be < moisture_high_threshold", Value: zone.MoistureLowThreshold}
	}
	if verr := rangeI(prefix+"drain_period_secs", &zone.DrainPeriodSecs, 0, 1<<31); verr != nil {
		return verr
	}
	if verr := pattern(prefix+"schedule", zone.Schedule, scheduleRe); verr != nil {
		return verr
	}
	return nil
}

// validateProfile checks a full crop profile: id slug, non-empty name/crop, at least one stage
// with unique non-empty labels, and a fully-valid target bundle per stage.
func validateProfile(profile domain.CropProfile) *valError {
	if !domain.ValidSlug(profile.ID) {
		return &valError{Field: "id", Bound: "lowercase kebab slug", Value: profile.ID}
	}
	if strings.TrimSpace(profile.Name) == "" {
		return &valError{Field: "name", Bound: "non-empty", Value: profile.Name}
	}
	if strings.TrimSpace(profile.Crop) == "" {
		return &valError{Field: "crop", Bound: "non-empty", Value: profile.Crop}
	}
	return validateStages(profile.Stages)
}

// validateStages checks a profile's stage list (used by create and by a patch that replaces stages).
func validateStages(stages []domain.ProfileStage) *valError {
	if len(stages) == 0 {
		return &valError{Field: "stages", Bound: "at least one stage", Value: nil}
	}
	seen := make(map[string]bool, len(stages))
	for index, stage := range stages {
		if strings.TrimSpace(stage.Stage) == "" {
			return &valError{Field: fmt.Sprintf("stages[%d].stage", index), Bound: "non-empty", Value: stage.Stage}
		}
		if seen[stage.Stage] {
			return &valError{Field: fmt.Sprintf("stages[%d].stage", index), Bound: "unique", Value: stage.Stage}
		}
		seen[stage.Stage] = true
		if verr := validateSetpoints(stage.Targets); verr != nil {
			verr.Field = fmt.Sprintf("stages[%d].targets.%s", index, verr.Field)
			return verr
		}
		if verr := validateStageBounds(stage.Targets, stage.Bounds); verr != nil {
			verr.Field = fmt.Sprintf("stages[%d].%s", index, verr.Field)
			return verr
		}
	}
	return nil
}

// validateProfilePatch checks a partial profile update (at least one of name/crop/stages).
func validateProfilePatch(patch cropProfilePatchDTO) *valError {
	if patch.Name == nil && patch.Crop == nil && patch.Stages == nil {
		return &valError{Field: "(body)", Bound: "at least one of name/crop/stages", Value: nil}
	}
	if patch.Name != nil && strings.TrimSpace(*patch.Name) == "" {
		return &valError{Field: "name", Bound: "non-empty", Value: *patch.Name}
	}
	if patch.Crop != nil && strings.TrimSpace(*patch.Crop) == "" {
		return &valError{Field: "crop", Bound: "non-empty", Value: *patch.Crop}
	}
	if patch.Stages != nil {
		return validateStages(patch.Stages)
	}
	return nil
}

// validateAssignmentInput checks the profile/stage assignment body's shape; that the profile
// exists and the stage belongs to it is checked against the store in the handler (422).
func validateAssignmentInput(input assignmentInputDTO) *valError {
	if !domain.ValidSlug(input.ProfileID) {
		return &valError{Field: "profile_id", Bound: "lowercase kebab slug", Value: input.ProfileID}
	}
	if strings.TrimSpace(input.Stage) == "" {
		return &valError{Field: "stage", Bound: "non-empty", Value: input.Stage}
	}
	return nil
}
