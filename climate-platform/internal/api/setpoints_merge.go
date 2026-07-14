package api

import (
	"encoding/json"
	"fmt"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// zoneTargetFields are the per-zone fields the platform-dashboard-rest Setpoints bundle carries. The
// controller's GET /zones response also includes live status (soil_moisture_vwc, irrigating,
// faulted, last_cycle_ts); those are projected out so the detail's setpoints match the contract's
// ZoneTargets (additionalProperties:false).
var zoneTargetFields = []string{
	"zone_id",
	"moisture_low_threshold",
	"moisture_high_threshold",
	"drain_period_secs",
	"schedule",
}

// mergeSetpointsZones folds the controller's per-zone targets (from GET /zones) into its global
// setpoints (from GET /setpoints), producing the aggregated Setpoints bundle the platform-dashboard-rest
// contract requires (global setpoints + a `zones` array). The controller serves the two as separate
// resources; the platform is the aggregation layer.
func mergeSetpointsZones(setpoints, zones []byte) (json.RawMessage, error) {
	var bundle map[string]json.RawMessage
	if err := json.Unmarshal(setpoints, &bundle); err != nil {
		return nil, fmt.Errorf("decode setpoints: %w", err)
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(zones, &rows); err != nil {
		return nil, fmt.Errorf("decode zones: %w", err)
	}

	targets := make([]map[string]json.RawMessage, len(rows))
	for i, row := range rows {
		target := make(map[string]json.RawMessage, len(zoneTargetFields))
		for _, field := range zoneTargetFields {
			if value, ok := row[field]; ok {
				target[field] = value
			}
		}
		targets[i] = target
	}

	zonesRaw, err := json.Marshal(targets)
	if err != nil {
		return nil, err
	}
	bundle["zones"] = zonesRaw
	return json.Marshal(bundle)
}

// overlayGlobalSetpoints replaces the global climate setpoints in a controller-reported bundle with
// the platform's intended global setpoints, keeping the controller's per-zone config. The platform
// is the setpoint authority (2b, RFC-005), so the detail reflects a profile assignment or ad-hoc
// edit immediately rather than lagging a controller tick. The controller's actual per-zone
// thresholds are preserved (a profile may not govern every zone), and any divergence between
// intended and the controller's reported globals is surfaced separately as `drift`.
func overlayGlobalSetpoints(reported []byte, intended domain.Setpoints) (json.RawMessage, error) {
	var reportedFields map[string]json.RawMessage
	if err := json.Unmarshal(reported, &reportedFields); err != nil {
		return nil, fmt.Errorf("decode reported setpoints: %w", err)
	}
	intendedBytes, err := json.Marshal(intended)
	if err != nil {
		return nil, err
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(intendedBytes, &result); err != nil {
		return nil, err
	}
	// Keep the controller-reported per-zone config rather than the (possibly empty) intended zones.
	if zones, ok := reportedFields["zones"]; ok {
		result["zones"] = zones
	}
	return json.Marshal(result)
}
