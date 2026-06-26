package api

import (
	"encoding/json"
	"fmt"
)

// zoneTargetFields are the per-zone fields the frontend-rest Setpoints bundle carries. The
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
// setpoints (from GET /setpoints), producing the aggregated Setpoints bundle the frontend-rest
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

// stripZones removes the `zones` field from a setpoints patch before it is relayed to the
// controller's PATCH /setpoints, which only owns the global setpoints (zone targets are a separate
// controller resource and would be rejected). The original bytes are returned unchanged when there
// is no `zones` field, preserving pass-through fidelity.
func stripZones(raw []byte) ([]byte, error) {
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil {
		return nil, err
	}
	if _, ok := patch["zones"]; !ok {
		return raw, nil
	}
	delete(patch, "zones")
	return json.Marshal(patch)
}
