package domain

// setpointEpsilon is the tolerance for comparing two setpoint bundles' floating-point
// fields. Controller-reported setpoints round-trip through JSON and the controller's own
// representation, so an exact float compare would flag spurious drift.
const setpointEpsilon = 1e-6

// ZoneTargets is one irrigation zone's runtime-adjustable targets, mirroring the
// controller's per-zone config so a resolved profile maps onto it directly
// (contracts/frontend-rest ZoneTargets, platform data model §3). Zone *topology* (adding
// or removing zones) is a controller config + restart change, not part of this write path.
type ZoneTargets struct {
	ZoneID                string  `json:"zone_id"`
	MoistureLowThreshold  float64 `json:"moisture_low_threshold"`
	MoistureHighThreshold float64 `json:"moisture_high_threshold"`
	DrainPeriodSecs       int     `json:"drain_period_secs"`
	Schedule              string  `json:"schedule"`
}

// Setpoints is a greenhouse's full target bundle — the global climate setpoints plus
// per-zone irrigation targets. It deliberately mirrors the controller's runtime-adjustable
// config (contracts/frontend-rest Setpoints) so resolving a crop profile is a mapping, not
// a translation: the same JSON serializes to the controller's PATCH body, to the
// WebSocket, and to the JSONB provenance ledger.
type Setpoints struct {
	TemperatureDayC              float64       `json:"temperature_day_c"`
	TemperatureNightC            float64       `json:"temperature_night_c"`
	DayStart                     string        `json:"day_start"`
	DayEnd                       string        `json:"day_end"`
	HumidityLowPct               float64       `json:"humidity_low_pct"`
	HumidityHighPct              float64       `json:"humidity_high_pct"`
	HumidityDeadbandPct          float64       `json:"humidity_deadband_pct"`
	CO2TargetPPM                 int           `json:"co2_target_ppm"`
	CO2VentInterlockThresholdPct float64       `json:"co2_vent_interlock_threshold_pct"`
	VPDTargetKPa                 float64       `json:"vpd_target_kpa"`
	DLITargetMol                 float64       `json:"dli_target_mol"`
	Zones                        []ZoneTargets `json:"zones"`
}

// Equal reports whether two setpoint bundles are exactly equivalent within floating-point
// tolerance, including the same set of zones (order-independent).
func (s Setpoints) Equal(other Setpoints) bool {
	return s.globalEqual(other) && len(s.Zones) == len(other.Zones) && s.zonesCoveredBy(other)
}

// Reconciled reports whether a controller's reported setpoints satisfy this (intended) bundle:
// the global setpoints match and every zone this bundle governs is present on the controller with
// matching targets. Extra zones the controller reports but the profile does not govern are ignored
// — zone topology is controller-local and not in the platform's write path (platform data model §3),
// so an unmanaged zone is never drift. This is the test the reconciler applies between intended and
// controller-reported setpoints.
func (s Setpoints) Reconciled(reported Setpoints) bool {
	return s.globalEqual(reported) && s.zonesCoveredBy(reported)
}

// globalEqual compares the global climate setpoints (everything but the per-zone targets).
func (s Setpoints) globalEqual(other Setpoints) bool {
	if s.DayStart != other.DayStart || s.DayEnd != other.DayEnd || s.CO2TargetPPM != other.CO2TargetPPM {
		return false
	}
	return floatsEqual(s.TemperatureDayC, other.TemperatureDayC) &&
		floatsEqual(s.TemperatureNightC, other.TemperatureNightC) &&
		floatsEqual(s.HumidityLowPct, other.HumidityLowPct) &&
		floatsEqual(s.HumidityHighPct, other.HumidityHighPct) &&
		floatsEqual(s.HumidityDeadbandPct, other.HumidityDeadbandPct) &&
		floatsEqual(s.CO2VentInterlockThresholdPct, other.CO2VentInterlockThresholdPct) &&
		floatsEqual(s.VPDTargetKPa, other.VPDTargetKPa) &&
		floatsEqual(s.DLITargetMol, other.DLITargetMol)
}

// zonesCoveredBy reports whether every zone in s has an equal-target counterpart in other (matched
// by zone_id). It does not require other to be zone-for-zone identical — other may carry additional
// zones s does not govern.
func (s Setpoints) zonesCoveredBy(other Setpoints) bool {
	otherZones := make(map[string]ZoneTargets, len(other.Zones))
	for _, zone := range other.Zones {
		otherZones[zone.ZoneID] = zone
	}
	for _, zone := range s.Zones {
		match, ok := otherZones[zone.ZoneID]
		if !ok || !zone.equal(match) {
			return false
		}
	}
	return true
}

func (z ZoneTargets) equal(other ZoneTargets) bool {
	return z.ZoneID == other.ZoneID &&
		z.Schedule == other.Schedule &&
		z.DrainPeriodSecs == other.DrainPeriodSecs &&
		floatsEqual(z.MoistureLowThreshold, other.MoistureLowThreshold) &&
		floatsEqual(z.MoistureHighThreshold, other.MoistureHighThreshold)
}

func floatsEqual(a, b float64) bool {
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff <= setpointEpsilon
}
