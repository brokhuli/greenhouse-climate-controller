package api

import (
	"fmt"
	"math"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// Generic physical ranges for the scalar climate setpoints — the absolute bounds any target must sit
// within, independent of crop. Untyped so they serve both the float64 range checks and the int
// co2_target_ppm check, and the crop-safe-envelope table below. This is the single source of truth
// the value checks (validateSetpoints / validateSetpointsPatch) and the bound checks share.
const (
	physTempMinC       = -20
	physTempMaxC       = 60
	physPctMin         = 0
	physPctMax         = 100
	physDeadbandMaxPct = 50
	physCO2MinPpm      = 0
	physCO2MaxPpm      = 5000
	physMoistureMin    = 0
	physMoistureMax    = 1
	physDrainMinSecs   = 0
	physDrainMaxSecs   = 1 << 31
)

// climateBoundField pairs a scalar climate setpoint's wire name and generic physical range with
// accessors for its value in a Setpoints bundle and its crop-safe Bound in a StageBounds envelope. It
// is the single table the envelope validators iterate, so a bound's range and the target it must
// contain are always checked against the same physical limits the primary value validation uses.
// hi == MaxFloat64 marks a target unbounded above (vpd, dli — physically non-negative only).
type climateBoundField struct {
	name  string
	lo    float64
	hi    float64
	value func(domain.Setpoints) float64
	bound func(domain.StageBounds) *domain.Bound
}

var climateBoundFields = []climateBoundField{
	{"temperature_day_c", physTempMinC, physTempMaxC,
		func(s domain.Setpoints) float64 { return s.TemperatureDayC },
		func(b domain.StageBounds) *domain.Bound { return b.TemperatureDayC }},
	{"temperature_night_c", physTempMinC, physTempMaxC,
		func(s domain.Setpoints) float64 { return s.TemperatureNightC },
		func(b domain.StageBounds) *domain.Bound { return b.TemperatureNightC }},
	{"humidity_low_pct", physPctMin, physPctMax,
		func(s domain.Setpoints) float64 { return s.HumidityLowPct },
		func(b domain.StageBounds) *domain.Bound { return b.HumidityLowPct }},
	{"humidity_high_pct", physPctMin, physPctMax,
		func(s domain.Setpoints) float64 { return s.HumidityHighPct },
		func(b domain.StageBounds) *domain.Bound { return b.HumidityHighPct }},
	{"humidity_deadband_pct", physPctMin, physDeadbandMaxPct,
		func(s domain.Setpoints) float64 { return s.HumidityDeadbandPct },
		func(b domain.StageBounds) *domain.Bound { return b.HumidityDeadbandPct }},
	{"co2_target_ppm", physCO2MinPpm, physCO2MaxPpm,
		func(s domain.Setpoints) float64 { return float64(s.CO2TargetPPM) },
		func(b domain.StageBounds) *domain.Bound { return b.CO2TargetPpm }},
	{"co2_vent_interlock_threshold_pct", physPctMin, physPctMax,
		func(s domain.Setpoints) float64 { return s.CO2VentInterlockThresholdPct },
		func(b domain.StageBounds) *domain.Bound { return b.CO2VentInterlockThresholdPct }},
	{"vpd_target_kpa", 0, math.MaxFloat64,
		func(s domain.Setpoints) float64 { return s.VPDTargetKPa },
		func(b domain.StageBounds) *domain.Bound { return b.VPDTargetKpa }},
	{"dli_target_mol", 0, math.MaxFloat64,
		func(s domain.Setpoints) float64 { return s.DLITargetMol },
		func(b domain.StageBounds) *domain.Bound { return b.DLITargetMol }},
}

// rangeLabel renders a field's physical range for a 422 Bound message (">= lo" when unbounded above).
func (f climateBoundField) rangeLabel() string {
	if f.hi == math.MaxFloat64 {
		return fmt.Sprintf(">= %g", f.lo)
	}
	return fmt.Sprintf("%g..%g", f.lo, f.hi)
}

// zoneBoundField is the per-zone analogue of climateBoundField: it pairs a numeric irrigation
// target's wire name and generic physical range with accessors for its value on a ZoneTargets and
// its crop-safe Bound in a ZoneBounds envelope. schedule (time-of-day triggers) is not envelope-able
// and is absent, mirroring the global day window.
type zoneBoundField struct {
	name  string
	lo    float64
	hi    float64
	value func(domain.ZoneTargets) float64
	bound func(domain.ZoneBounds) *domain.Bound
}

var zoneBoundFields = []zoneBoundField{
	{"moisture_low_threshold", physMoistureMin, physMoistureMax,
		func(z domain.ZoneTargets) float64 { return z.MoistureLowThreshold },
		func(b domain.ZoneBounds) *domain.Bound { return b.MoistureLowThreshold }},
	{"moisture_high_threshold", physMoistureMin, physMoistureMax,
		func(z domain.ZoneTargets) float64 { return z.MoistureHighThreshold },
		func(b domain.ZoneBounds) *domain.Bound { return b.MoistureHighThreshold }},
	{"drain_period_secs", physDrainMinSecs, physDrainMaxSecs,
		func(z domain.ZoneTargets) float64 { return float64(z.DrainPeriodSecs) },
		func(b domain.ZoneBounds) *domain.Bound { return b.DrainPeriodSecs }},
}

// rangeLabel renders a zone field's physical range for a 422 Bound message.
func (f zoneBoundField) rangeLabel() string {
	return fmt.Sprintf("%g..%g", f.lo, f.hi)
}

// validateStageBounds checks a growth stage's optional crop-safe envelope. For each present target
// bound: min <= max, both endpoints inside the target's generic physical range, and the stage's own
// baseline target for that field must fall within [min, max] — a profile whose baseline lies outside
// its own envelope is self-contradictory. A nil envelope (or an unset per-target bound) is valid;
// bounds are optional. The returned valError's Field is bounds-relative (e.g. bounds.temperature_day_c)
// and prefixed with the stage index by the caller.
func validateStageBounds(targets domain.Setpoints, bounds *domain.StageBounds) *valError {
	if bounds == nil {
		return nil
	}
	for _, f := range climateBoundFields {
		b := f.bound(*bounds)
		if b == nil {
			continue
		}
		field := "bounds." + f.name
		if b.Min > b.Max {
			return &valError{Field: field, Bound: "min <= max", Value: b.Min}
		}
		if b.Min < f.lo {
			return &valError{Field: field, Bound: f.rangeLabel(), Value: b.Min}
		}
		if b.Max > f.hi {
			return &valError{Field: field, Bound: f.rangeLabel(), Value: b.Max}
		}
		if target := f.value(targets); target < b.Min || target > b.Max {
			return &valError{Field: field, Bound: fmt.Sprintf("must contain target %g", target), Value: target}
		}
	}
	if verr := validateZoneStageBounds(targets.Zones, bounds.Zones); verr != nil {
		return verr
	}
	return nil
}

// validateZoneStageBounds is the per-zone analogue of the climate loop in validateStageBounds: for
// each present zone bound, min <= max and both endpoints inside the target's physical range, and
// every zone's own baseline target for that field must fall within [min, max] (the uniform envelope
// applies to all zones, so all must satisfy it). A nil envelope is valid.
func validateZoneStageBounds(zones []domain.ZoneTargets, bounds *domain.ZoneBounds) *valError {
	if bounds == nil {
		return nil
	}
	for _, f := range zoneBoundFields {
		b := f.bound(*bounds)
		if b == nil {
			continue
		}
		field := "bounds.zones." + f.name
		if b.Min > b.Max {
			return &valError{Field: field, Bound: "min <= max", Value: b.Min}
		}
		if b.Min < f.lo {
			return &valError{Field: field, Bound: f.rangeLabel(), Value: b.Min}
		}
		if b.Max > f.hi {
			return &valError{Field: field, Bound: f.rangeLabel(), Value: b.Max}
		}
		for _, zone := range zones {
			if target := f.value(zone); target < b.Min || target > b.Max {
				return &valError{Field: field, Bound: fmt.Sprintf("must contain target %g", target), Value: target}
			}
		}
	}
	return nil
}

// validateSetpointsWithinBounds enforces a resolved setpoint bundle against a stage's crop-safe
// envelope: each present target bound must contain the candidate's value. It is the platform-side
// backstop on optimizer writes (RFC-005) — a violation is the "422 = outside the crop-safe envelope"
// signal the optimizer's own constraint engine mirrors. Targets with no envelope are unconstrained
// here (the generic physical bounds already applied).
func validateSetpointsWithinBounds(setpoints domain.Setpoints, bounds domain.StageBounds) *valError {
	for _, f := range climateBoundFields {
		b := f.bound(bounds)
		if b == nil {
			continue
		}
		if v := f.value(setpoints); v < b.Min || v > b.Max {
			return &valError{Field: f.name, Bound: fmt.Sprintf("crop-safe %g..%g", b.Min, b.Max), Value: v}
		}
	}
	if zb := bounds.Zones; zb != nil {
		for index, zone := range setpoints.Zones {
			for _, f := range zoneBoundFields {
				b := f.bound(*zb)
				if b == nil {
					continue
				}
				if v := f.value(zone); v < b.Min || v > b.Max {
					return &valError{
						Field: fmt.Sprintf("zones[%d].%s", index, f.name),
						Bound: fmt.Sprintf("crop-safe %g..%g", b.Min, b.Max),
						Value: v,
					}
				}
			}
		}
	}
	return nil
}
