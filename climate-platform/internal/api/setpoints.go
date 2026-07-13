package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/auth"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
)

// editSetpoints is the operator's ad-hoc setpoint edit (200). In 2b it is no longer a thin relay:
// the edit's global fields are merged onto the greenhouse's current intended state (or the
// controller's reported setpoints when none exists yet) and applied through the reconciler, so it
// becomes sticky intended state — re-asserted on reconnect rather than silently reverted
// (crop-profiles §5).
func (s *Server) editSetpoints(c echo.Context) error {
	return s.applySetpointWrite(c, domain.SourceOperatorEdit, "operator", "ad-hoc edit", http.StatusOK)
}

// submitSetpoints is the optimizer's single-authority setpoint write path (RFC-005 / RFC-011,
// POST /setpoints). It shares editSetpoints' merge/validate/reconcile machinery but records
// optimizer provenance and returns 202 Accepted (this surface's contract success code). Its gate
// is SERVICE_AUTH_MODE-dependent (server route): in the default trusted_network mode it accepts the
// untokened internal call; in oidc mode it requires a setpoints:write service token (or operator).
func (s *Server) submitSetpoints(c echo.Context) error {
	actor := s.setpointActor(c, "optimizer")
	return s.applySetpointWrite(c, domain.SourceOptimizer, actor, "optimizer setpoint submission", http.StatusAccepted)
}

// resolveStageBounds returns the crop-safe envelope of the greenhouse's active profile stage, used to
// gate optimizer setpoint writes. It is nil when the greenhouse has no assignment, the assigned
// profile or stage is gone, or the stage defines no envelope — in which case the optimizer write falls
// back to the generic physical bounds alone. A store error is propagated (surfaced as 500).
func (s *Server) resolveStageBounds(ctx context.Context, greenhouseID string) (*domain.StageBounds, error) {
	assignment, found, err := s.store.GetAssignment(ctx, greenhouseID)
	if err != nil || !found {
		return nil, err
	}
	profile, found, err := s.store.GetProfile(ctx, assignment.ProfileID)
	if err != nil || !found {
		return nil, err
	}
	stage, ok := profile.Stage(assignment.Stage)
	if !ok {
		return nil, nil
	}
	return stage.Bounds, nil
}

// setpointActor is the audit actor for a setpoint write: the authenticated token's username (or
// subject) when present, else the fallback for the untokened trusted_network path.
func (s *Server) setpointActor(c echo.Context, fallback string) string {
	if claims := auth.ClaimsFrom(c); claims != nil {
		if claims.Username != "" {
			return claims.Username
		}
		if claims.Subject != "" {
			return claims.Subject
		}
	}
	return fallback
}

// applySetpointWrite is the shared body of the operator edit and the optimizer submission: decode
// and validate the partial edit, merge it onto the reconciler's baseline, and apply it as sticky
// intended state under the given provenance. An out-of-range value is rejected 422; an unreachable
// controller with no prior intended state is 503; a controller that rejects the delivery has its
// status/body passed through; otherwise the write is accepted (delivered, or held when offline) and
// the resulting bundle returned with successStatus.
func (s *Server) applySetpointWrite(c echo.Context, source domain.SetpointSource, actor, description string, successStatus int) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !exists {
		return respondNotFound(c, "greenhouse not found")
	}

	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "could not read body")
	}
	patch, err := decodeSetpointsPatch(raw)
	if err != nil {
		if field, ok := unknownFieldName(err); ok {
			return respondValidation(c, &valError{Field: field, Bound: "unknown field not permitted"})
		}
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	if patchIsEmpty(patch) {
		return respondValidation(c, &valError{Field: "(body)", Bound: "at least one setpoint field", Value: nil})
	}
	if verr := validateSetpointsPatch(patch); verr != nil {
		return respondValidation(c, verr)
	}

	baseline, err := s.reconcile.Baseline(ctx, id)
	if err != nil {
		if errors.Is(err, reconcile.ErrUnknownGreenhouse) {
			return respondNotFound(c, "greenhouse not found")
		}
		// No intended state yet and the controller could not be reached to seed one.
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	candidate, patchErr := applyPatch(baseline, patch)
	if patchErr != nil {
		return respondValidation(c, patchErr)
	}
	if verr := validateSetpoints(candidate); verr != nil {
		return respondValidation(c, verr)
	}
	// Optimizer writes are additionally gated to the active crop profile stage's crop-safe envelope
	// (RFC-005): a candidate outside it is rejected 422 naming the violated bound. Operator edits are
	// deliberately not gated here — a sticky operator edit wins over the profile (crop-profiles §5).
	if source == domain.SourceOptimizer {
		bounds, err := s.resolveStageBounds(ctx, id)
		if err != nil {
			return s.fail(c, err)
		}
		if bounds != nil {
			if verr := validateSetpointsWithinBounds(candidate, *bounds); verr != nil {
				return respondValidation(c, verr)
			}
		}
	}

	outcome, err := s.reconcile.Apply(ctx, id, candidate, source, actor, description)
	if err != nil {
		if errors.Is(err, reconcile.ErrUnknownGreenhouse) {
			return respondNotFound(c, "greenhouse not found")
		}
		return s.fail(c, err)
	}
	if outcome.ControllerStatus != 0 && !outcome.Delivered && !outcome.Deferred {
		return c.JSONBlob(outcome.ControllerStatus, outcome.ControllerBody)
	}
	return c.JSON(successStatus, outcome.Setpoints)
}

// applyPatch merges a partial edit onto a baseline bundle: the global climate fields overwrite their
// targets, and a present zones array updates the matching baseline zones by zone_id (mergeZonePatch).
// Zone topology is fixed — a zone_id the baseline does not have is rejected — so the merged bundle
// always covers exactly the greenhouse's configured zones. A zone-level rejection surfaces as 422.
func applyPatch(base domain.Setpoints, patch setpointsPatchDTO) (domain.Setpoints, *valError) {
	if patch.TemperatureDayC != nil {
		base.TemperatureDayC = *patch.TemperatureDayC
	}
	if patch.TemperatureNightC != nil {
		base.TemperatureNightC = *patch.TemperatureNightC
	}
	if patch.DayStart != nil {
		base.DayStart = *patch.DayStart
	}
	if patch.DayEnd != nil {
		base.DayEnd = *patch.DayEnd
	}
	if patch.HumidityLowPct != nil {
		base.HumidityLowPct = *patch.HumidityLowPct
	}
	if patch.HumidityHighPct != nil {
		base.HumidityHighPct = *patch.HumidityHighPct
	}
	if patch.HumidityDeadbandPct != nil {
		base.HumidityDeadbandPct = *patch.HumidityDeadbandPct
	}
	if patch.CO2TargetPpm != nil {
		base.CO2TargetPPM = *patch.CO2TargetPpm
	}
	if patch.CO2VentInterlockThresholdPct != nil {
		base.CO2VentInterlockThresholdPct = *patch.CO2VentInterlockThresholdPct
	}
	if patch.VPDTargetKpa != nil {
		base.VPDTargetKPa = *patch.VPDTargetKpa
	}
	if patch.DLITargetMol != nil {
		base.DLITargetMol = *patch.DLITargetMol
	}
	if patch.Zones != nil {
		zones, verr := mergeZonePatch(base.Zones, patch.Zones)
		if verr != nil {
			return domain.Setpoints{}, verr
		}
		base.Zones = zones
	}
	return base, nil
}

// mergeZonePatch overlays a patch's per-zone targets onto the baseline zone set, matched by zone_id.
// Each patch entry must fully specify its targets (all fields present — a zone write replaces that
// zone's whole bundle) and name a zone the baseline already has; an unknown zone_id (a topology
// change, which is a controller config + restart concern) or a duplicate id is rejected 422. Zones
// the patch does not name are carried through unchanged. The returned slice is fresh — the baseline's
// backing array is never mutated.
func mergeZonePatch(base []domain.ZoneTargets, patch []zoneTargetsDTO) ([]domain.ZoneTargets, *valError) {
	merged := make([]domain.ZoneTargets, len(base))
	copy(merged, base)
	position := make(map[string]int, len(base))
	for i, zone := range base {
		position[zone.ZoneID] = i
	}
	seen := make(map[string]bool, len(patch))
	for i, dto := range patch {
		field := fmt.Sprintf("zones[%d]", i)
		zone, verr := zoneFromDTO(field, dto)
		if verr != nil {
			return nil, verr
		}
		pos, ok := position[zone.ZoneID]
		if !ok {
			return nil, &valError{Field: field + ".zone_id", Bound: "unknown zone", Value: zone.ZoneID}
		}
		if seen[zone.ZoneID] {
			return nil, &valError{Field: field + ".zone_id", Bound: "duplicate", Value: zone.ZoneID}
		}
		seen[zone.ZoneID] = true
		merged[pos] = zone
	}
	return merged, nil
}

// zoneFromDTO converts a fully-specified zone patch entry into a domain ZoneTargets. Every target
// field is required on a zone write (contracts ZoneTargets required set); a missing field is a 422.
// Value ranges and the moisture ordering are already checked by validateZone before this runs.
func zoneFromDTO(field string, dto zoneTargetsDTO) (domain.ZoneTargets, *valError) {
	required := []struct {
		name    string
		present bool
	}{
		{"zone_id", dto.ZoneID != nil},
		{"moisture_low_threshold", dto.MoistureLowThreshold != nil},
		{"moisture_high_threshold", dto.MoistureHighThreshold != nil},
		{"drain_period_secs", dto.DrainPeriodSecs != nil},
		{"schedule", dto.Schedule != nil},
	}
	for _, r := range required {
		if !r.present {
			return domain.ZoneTargets{}, &valError{Field: field + "." + r.name, Bound: "required"}
		}
	}
	return domain.ZoneTargets{
		ZoneID:                *dto.ZoneID,
		MoistureLowThreshold:  *dto.MoistureLowThreshold,
		MoistureHighThreshold: *dto.MoistureHighThreshold,
		DrainPeriodSecs:       *dto.DrainPeriodSecs,
		Schedule:              *dto.Schedule,
	}, nil
}

// decodeSetpointsPatch parses the patch body, rejecting unknown fields to honor the
// SetpointsPatch contract's additionalProperties:false (platform-dashboard-rest setpoints.json).
// DisallowUnknownFields applies to nested zones[] objects too.
func decodeSetpointsPatch(raw []byte) (setpointsPatchDTO, error) {
	var patch setpointsPatchDTO
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return patch, dec.Decode(&patch)
}

// unknownFieldName pulls the offending field out of a DisallowUnknownFields decode error
// (Go reports `json: unknown field "x"`); ok is false for any other decode error.
func unknownFieldName(err error) (string, bool) {
	const prefix = "json: unknown field "
	if err == nil {
		return "", false
	}
	if msg := err.Error(); strings.HasPrefix(msg, prefix) {
		return strings.Trim(strings.TrimPrefix(msg, prefix), `"`), true
	}
	return "", false
}

func patchIsEmpty(patch setpointsPatchDTO) bool {
	return patch.TemperatureDayC == nil && patch.TemperatureNightC == nil &&
		patch.DayStart == nil && patch.DayEnd == nil &&
		patch.HumidityLowPct == nil && patch.HumidityHighPct == nil && patch.HumidityDeadbandPct == nil &&
		patch.CO2TargetPpm == nil && patch.CO2VentInterlockThresholdPct == nil &&
		patch.VPDTargetKpa == nil && patch.DLITargetMol == nil && patch.Zones == nil
}
