package api

import (
	"encoding/json"
	"fmt"
)

// zoneStatusDTO is the live per-zone irrigation state the detail snapshot carries alongside the
// target-only setpoints.zones. It mirrors the read-only half of the controller's GET /zones
// ZoneStatus; the mutable targets are projected into setpoints.zones by mergeSetpointsZones. The
// pointer fields preserve the controller's null for a faulted sensor / never-cycled zone.
type zoneStatusDTO struct {
	ZoneID          string   `json:"zone_id"`
	SoilMoistureVWC *float64 `json:"soil_moisture_vwc"`
	Irrigating      bool     `json:"irrigating"`
	Faulted         bool     `json:"faulted"`
	LastCycleTS     *string  `json:"last_cycle_ts"`
}

// extractZoneStatus reads the live per-zone status out of the controller's GET /zones response.
// The controller's ZoneStatus also carries the config/target fields; those are ignored here (they
// reach the SPA via setpoints.zones) so the two views stay distinct. An empty zones array yields a
// non-nil slice so the JSON serializes as [] rather than null.
func extractZoneStatus(zones []byte) ([]zoneStatusDTO, error) {
	var rows []zoneStatusDTO
	if err := json.Unmarshal(zones, &rows); err != nil {
		return nil, fmt.Errorf("decode zone status: %w", err)
	}
	if rows == nil {
		rows = []zoneStatusDTO{}
	}
	return rows, nil
}
