package api

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// editSetpoints is the 2a thin relay: validate the partial edit, forward it to the
// controller's REST PATCH /setpoints, and return the controller's response verbatim so
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
	var patch setpointsPatchDTO
	if err := json.Unmarshal(raw, &patch); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	if patchIsEmpty(patch) {
		return respondValidation(c, &valError{Field: "(body)", Bound: "at least one setpoint field", Value: nil})
	}
	if verr := validateSetpointsPatch(patch); verr != nil {
		return respondValidation(c, verr)
	}

	resp, err := s.relay.Do(ctx, http.MethodPatch, endpoint.RESTBaseURL, "/setpoints", endpoint.BearerToken, raw)
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

func patchIsEmpty(patch setpointsPatchDTO) bool {
	return patch.TemperatureDayC == nil && patch.TemperatureNightC == nil &&
		patch.DayStart == nil && patch.DayEnd == nil &&
		patch.HumidityLowPct == nil && patch.HumidityHighPct == nil && patch.HumidityDeadbandPct == nil &&
		patch.CO2TargetPpm == nil && patch.CO2VentInterlockThresholdPct == nil &&
		patch.VPDTargetKpa == nil && patch.DLITargetMol == nil && patch.Zones == nil
}
