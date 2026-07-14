package api

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// valError is a single failed validation, rendered as the 422 ValidationError body.
type valError struct {
	Field string
	Bound string
	Value any
	Msg   string
}

func (v *valError) body() validationBody {
	msg := v.Msg
	if msg == "" {
		msg = fmt.Sprintf("%s violates %s", v.Field, v.Bound)
	}
	return validationBody{Error: msg, Field: v.Field, Bound: v.Bound, Value: v.Value}
}

var hhmmRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
var scheduleRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$`)

func minutesOfDay(hhmm string) (int, bool) {
	if !hhmmRe.MatchString(hhmm) {
		return 0, false
	}
	hour, _ := strconv.Atoi(hhmm[0:2])
	minute, _ := strconv.Atoi(hhmm[3:5])
	return hour*60 + minute, true
}

func rangeF(field string, value *float64, lo, hi float64) *valError {
	if value == nil {
		return nil
	}
	if *value < lo || *value > hi {
		return &valError{Field: field, Bound: fmt.Sprintf("%g..%g", lo, hi), Value: *value}
	}
	return nil
}

func rangeI(field string, value *int, lo, hi int) *valError {
	if value == nil {
		return nil
	}
	if *value < lo || *value > hi {
		return &valError{Field: field, Bound: fmt.Sprintf("%d..%d", lo, hi), Value: *value}
	}
	return nil
}

func minF(field string, value *float64, lo float64) *valError {
	if value == nil {
		return nil
	}
	if *value < lo {
		return &valError{Field: field, Bound: fmt.Sprintf(">= %g", lo), Value: *value}
	}
	return nil
}

func pattern(field, value string, re *regexp.Regexp) *valError {
	if !re.MatchString(value) {
		return &valError{Field: field, Bound: "format " + re.String(), Value: value}
	}
	return nil
}

// validateRegistration checks a greenhouse registration body.
func validateRegistration(reg registrationDTO) *valError {
	if !domain.ValidSlug(reg.ID) {
		return &valError{Field: "id", Bound: "lowercase kebab slug", Value: reg.ID}
	}
	if strings.TrimSpace(reg.DisplayName) == "" {
		return &valError{Field: "display_name", Bound: "non-empty", Value: reg.DisplayName}
	}
	if strings.TrimSpace(reg.Controller.RESTBaseURL) == "" {
		return &valError{Field: "controller.rest_base_url", Bound: "non-empty URI", Value: reg.Controller.RESTBaseURL}
	}
	if strings.TrimSpace(reg.Controller.MQTTTopicRoot) == "" {
		return &valError{Field: "controller.mqtt_topic_root", Bound: "non-empty", Value: reg.Controller.MQTTTopicRoot}
	}
	return nil
}

// validateSetpointsPatch checks the bounds and cross-field invariants the schema cannot
// express, on the fields present in a partial setpoint edit (platform-dashboard-rest SetpointsPatch).
func validateSetpointsPatch(patch setpointsPatchDTO) *valError {
	checks := []*valError{
		rangeF("temperature_day_c", patch.TemperatureDayC, physTempMinC, physTempMaxC),
		rangeF("temperature_night_c", patch.TemperatureNightC, physTempMinC, physTempMaxC),
		rangeF("humidity_low_pct", patch.HumidityLowPct, physPctMin, physPctMax),
		rangeF("humidity_high_pct", patch.HumidityHighPct, physPctMin, physPctMax),
		rangeF("humidity_deadband_pct", patch.HumidityDeadbandPct, physPctMin, physDeadbandMaxPct),
		rangeI("co2_target_ppm", patch.CO2TargetPpm, physCO2MinPpm, physCO2MaxPpm),
		rangeF("co2_vent_interlock_threshold_pct", patch.CO2VentInterlockThresholdPct, physPctMin, physPctMax),
		minF("vpd_target_kpa", patch.VPDTargetKpa, 0),
		minF("dli_target_mol", patch.DLITargetMol, 0),
	}
	for _, check := range checks {
		if check != nil {
			return check
		}
	}
	if patch.DayStart != nil {
		if verr := pattern("day_start", *patch.DayStart, hhmmRe); verr != nil {
			return verr
		}
	}
	if patch.DayEnd != nil {
		if verr := pattern("day_end", *patch.DayEnd, hhmmRe); verr != nil {
			return verr
		}
	}
	if patch.DayStart != nil && patch.DayEnd != nil {
		start, _ := minutesOfDay(*patch.DayStart)
		end, _ := minutesOfDay(*patch.DayEnd)
		if end <= start {
			return &valError{Field: "day_end", Bound: "must be after day_start", Value: *patch.DayEnd}
		}
	}
	if patch.HumidityLowPct != nil && patch.HumidityHighPct != nil && *patch.HumidityLowPct >= *patch.HumidityHighPct {
		return &valError{Field: "humidity_low_pct", Bound: "must be < humidity_high_pct", Value: *patch.HumidityLowPct}
	}
	for index, zone := range patch.Zones {
		if verr := validateZone(index, zone); verr != nil {
			return verr
		}
	}
	return nil
}

func validateZone(index int, zone zoneTargetsDTO) *valError {
	prefix := fmt.Sprintf("zones[%d].", index)
	if zone.ZoneID != nil && !domain.ValidSlug(*zone.ZoneID) {
		return &valError{Field: prefix + "zone_id", Bound: "lowercase kebab slug", Value: *zone.ZoneID}
	}
	if verr := rangeF(prefix+"moisture_low_threshold", zone.MoistureLowThreshold, 0, 1); verr != nil {
		return verr
	}
	if verr := rangeF(prefix+"moisture_high_threshold", zone.MoistureHighThreshold, 0, 1); verr != nil {
		return verr
	}
	if zone.MoistureLowThreshold != nil && zone.MoistureHighThreshold != nil && *zone.MoistureLowThreshold >= *zone.MoistureHighThreshold {
		return &valError{Field: prefix + "moisture_low_threshold", Bound: "must be < moisture_high_threshold", Value: *zone.MoistureLowThreshold}
	}
	if verr := rangeI(prefix+"drain_period_secs", zone.DrainPeriodSecs, 0, 1<<31); verr != nil {
		return verr
	}
	if zone.Schedule != nil {
		if verr := pattern(prefix+"schedule", *zone.Schedule, scheduleRe); verr != nil {
			return verr
		}
	}
	return nil
}

// validateScale enforces the accepted simulation time-scale range (controller HAL §7).
func validateScale(scale *float64) *valError {
	if scale == nil {
		return &valError{Field: "scale", Bound: "required", Value: nil}
	}
	return rangeF("scale", scale, domain.MinTimeScale, domain.MaxTimeScale)
}
