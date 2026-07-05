package api

import (
	"bytes"
	"encoding/json"
	"errors"
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
	candidate := applyGlobalPatch(baseline, patch)
	if verr := validateSetpoints(candidate); verr != nil {
		return respondValidation(c, verr)
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

// applyGlobalPatch merges a partial edit's global setpoint fields onto a baseline bundle. Zone
// targets are carried from the baseline unchanged: ad-hoc zone-target edits are out of the 2b
// backbone (zone targets are governed by the assigned crop profile), mirroring 2a's decision not
// to relay zones through this path.
func applyGlobalPatch(base domain.Setpoints, patch setpointsPatchDTO) domain.Setpoints {
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
	return base
}

// decodeSetpointsPatch parses the patch body, rejecting unknown fields to honor the
// SetpointsPatch contract's additionalProperties:false (frontend-rest setpoints.json).
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
