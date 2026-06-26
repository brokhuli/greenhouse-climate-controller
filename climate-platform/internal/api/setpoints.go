package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// editSetpoints is the 2a thin relay: validate the partial edit, forward it to the
// controller's REST PATCH /greenhouses/{id}/setpoints, and return the response verbatim so
// its 200/404/422 propagates unchanged (RFC-005). A successful edit is recorded as a
// change-attribution audit event and pushed live.
func (s *Server) editSetpoints(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	endpoint, found, err := s.store.GetEndpoint(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
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

	// Zone targets are a separate controller resource; the controller's /setpoints PATCH owns only
	// the global setpoints, so strip zones from the relayed body (the platform still accepts them in
	// the frontend-rest patch — zone-target editing is not wired through this path in 2a).
	relayBody, err := stripZones(raw)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	resp, err := s.relay.Do(ctx, http.MethodPatch, endpoint.RESTBaseURL, controllerPath(id, "/setpoints"), endpoint.BearerToken, relayBody)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	if resp.Status >= 200 && resp.Status < 300 {
		event := domain.Event{
			GreenhouseID: id,
			TS:           time.Now().UTC(),
			Kind:         "setpoint_edit",
			Severity:     "info",
			Message:      "setpoint edit applied",
			Source:       "operator",
		}
		if err := s.store.InsertEvent(ctx, event); err != nil {
			s.log.Error("audit setpoint edit", "id", id, "err", err)
		}
		s.hub.Broadcast(ws.NewEvent(event))
		s.log.Info("setpoint edit relayed", "id", id, "status", resp.Status)
	}
	return c.JSONBlob(resp.Status, resp.Body)
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
