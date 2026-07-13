package reconcile

import (
	"encoding/json"
	"fmt"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// The reconciler is the control-down owner, so it builds the controller REST resource paths
// itself (the relay appends these to a controller's registered base URL; platform-controller-control-rest
// serves every resource under /greenhouses/{greenhouse_id}).
func controllerSetpointsPath(greenhouseID string) string {
	return "/greenhouses/" + greenhouseID + "/setpoints"
}

func controllerZonesPath(greenhouseID string) string {
	return "/greenhouses/" + greenhouseID + "/zones"
}

func controllerZonePath(greenhouseID, zoneID string) string {
	return "/greenhouses/" + greenhouseID + "/zones/" + zoneID
}

// globalSetpointsBody marshals a bundle's global climate setpoints for the controller's
// PATCH /setpoints, which owns only the global fields — the per-zone targets are delivered
// separately and would be rejected here (platform-controller-control-rest SetpointsPatch is
// additionalProperties:false).
func globalSetpointsBody(setpoints domain.Setpoints) ([]byte, error) {
	fields, err := toFieldMap(setpoints)
	if err != nil {
		return nil, err
	}
	delete(fields, "zones")
	return json.Marshal(fields)
}

// zoneBody marshals one zone's targets for the controller's PATCH /zones/{zone_id}. The
// zone_id travels in the path, not the body (platform-controller-control-rest ZoneConfigPatch).
func zoneBody(zone domain.ZoneTargets) ([]byte, error) {
	fields, err := toFieldMap(zone)
	if err != nil {
		return nil, err
	}
	delete(fields, "zone_id")
	return json.Marshal(fields)
}

// parseReported builds the controller's reported bundle from its GET /setpoints (global) and
// GET /zones (per-zone) responses — the input the drift check compares against intended. The
// zones response also carries live status fields (soil_moisture_vwc, irrigating, …); those
// are ignored, leaving only the target fields on each ZoneTargets.
func parseReported(setpointsBody, zonesBody []byte) (domain.Setpoints, error) {
	var reported domain.Setpoints
	if err := json.Unmarshal(setpointsBody, &reported); err != nil {
		return domain.Setpoints{}, fmt.Errorf("decode controller setpoints: %w", err)
	}
	var zones []domain.ZoneTargets
	if err := json.Unmarshal(zonesBody, &zones); err != nil {
		return domain.Setpoints{}, fmt.Errorf("decode controller zones: %w", err)
	}
	reported.Zones = zones
	return reported, nil
}

func toFieldMap(value any) (map[string]json.RawMessage, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}

func ok2xx(status int) bool { return status >= 200 && status < 300 }
