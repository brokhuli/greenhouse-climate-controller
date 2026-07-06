package api

import (
	"errors"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func (s *Server) listGreenhouses(c echo.Context) error {
	ctx := c.Request().Context()
	greenhouses, err := s.store.ListGreenhouses(ctx)
	if err != nil {
		return s.fail(c, err)
	}
	drift, err := s.store.ListDrift(ctx)
	if err != nil {
		return s.fail(c, err)
	}
	summaries := make([]greenhouseSummaryDTO, 0, len(greenhouses))
	for _, greenhouse := range greenhouses {
		summaries = append(summaries, s.summaryOf(greenhouse, drift[greenhouse.ID]))
	}
	return c.JSON(http.StatusOK, summaries)
}

func (s *Server) registerGreenhouse(c echo.Context) error {
	ctx := c.Request().Context()
	var req registrationDTO
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	if verr := validateRegistration(req); verr != nil {
		return respondValidation(c, verr)
	}
	registration := store.Registration{
		ID:          req.ID,
		DisplayName: req.DisplayName,
		Crop:        req.Crop,
		Endpoint: store.Endpoint{
			RESTBaseURL:   req.Controller.RESTBaseURL,
			MQTTTopicRoot: req.Controller.MQTTTopicRoot,
			// Optional per-controller pre-shared token (RFC-011); the platform presents it on every
			// downward REST write when the controller is hardened, nil otherwise.
			BearerToken: req.Controller.BearerToken,
		},
	}
	if err := s.store.Register(ctx, registration); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return respondValidation(c, &valError{Field: "id", Bound: "unique", Value: req.ID, Msg: "greenhouse already registered"})
		}
		return s.fail(c, err)
	}
	s.ing.Add(req.ID, req.Controller.MQTTTopicRoot)
	s.log.Info("greenhouse registered", "id", req.ID, "rest", req.Controller.RESTBaseURL)
	return c.JSON(http.StatusCreated, s.summaryOf(store.Greenhouse{ID: req.ID, DisplayName: req.DisplayName, Crop: req.Crop}, false))
}

func (s *Server) getGreenhouse(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	greenhouse, found, err := s.store.GetGreenhouse(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "greenhouse not found")
	}
	endpoint, endpointFound, err := s.store.GetEndpoint(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !endpointFound {
		return respondNotFound(c, "greenhouse not found")
	}
	// 2a thin relay: the platform does not own setpoints (that is the 2b intended-state
	// layer), so the detail snapshot reads the controller's current bundle live. A
	// controller that is unreachable yields 503 rather than a stale guess.
	resp, err := s.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, controllerPath(id, "/setpoints"), endpoint.BearerToken, nil)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	if resp.Status != http.StatusOK {
		return respondError(c, http.StatusServiceUnavailable, "controller did not return setpoints")
	}
	// The frontend-rest Setpoints bundle also carries per-zone targets, which the controller serves
	// as a separate resource; aggregate /zones into the setpoints the SPA receives.
	zonesResp, err := s.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, controllerPath(id, "/zones"), endpoint.BearerToken, nil)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	if zonesResp.Status != http.StatusOK {
		return respondError(c, http.StatusServiceUnavailable, "controller did not return zones")
	}
	setpoints, err := mergeSetpointsZones(resp.Body, zonesResp.Body)
	if err != nil {
		return s.fail(c, err)
	}
	// The same /zones body also carries each zone's live irrigation state, which the detail view
	// renders next to the targets; surface it as a sibling array (no extra controller call).
	zoneStatus, err := extractZoneStatus(zonesResp.Body)
	if err != nil {
		return s.fail(c, err)
	}
	recon, _, err := s.store.GetReconState(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	// When the platform holds intended state for this greenhouse, report its intended global
	// setpoints (authoritative, updated synchronously on assignment/edit) so the detail does not lag
	// a controller tick; the controller's per-zone config is kept and any divergence shows as drift.
	current, hasIntended, err := s.store.CurrentRevision(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if hasIntended {
		setpoints, err = overlayGlobalSetpoints(setpoints, current.Setpoints)
		if err != nil {
			return s.fail(c, err)
		}
	}
	live := s.liveFields(id)
	return c.JSON(http.StatusOK, greenhouseDetailDTO{
		ID:          greenhouse.ID,
		DisplayName: greenhouse.DisplayName,
		Crop:        greenhouse.Crop,
		Status:      live.Status,
		Drift:       recon.Drift,
		TimeScale:   live.TimeScale,
		Setpoints:   setpoints,
		ZoneStatus:  zoneStatus,
	})
}

func (s *Server) retireGreenhouse(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	found, err := s.store.Retire(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "greenhouse not found")
	}
	s.ing.Remove(id)
	s.log.Info("greenhouse retired", "id", id)
	return c.NoContent(http.StatusNoContent)
}

// summaryOf overlays the in-memory live state and the reconciliation drift flag onto a
// registry row.
func (s *Server) summaryOf(greenhouse store.Greenhouse, drift bool) greenhouseSummaryDTO {
	live := s.liveFields(greenhouse.ID)
	return greenhouseSummaryDTO{
		ID:          greenhouse.ID,
		DisplayName: greenhouse.DisplayName,
		Crop:        greenhouse.Crop,
		Status:      live.Status,
		Drift:       drift,
		TimeScale:   live.TimeScale,
		Climate:     climateDTO{Temperature: live.Temperature, Humidity: live.Humidity, CO2: live.CO2, DLI: live.DLI},
	}
}

// liveSummary is the live state a fleet summary reads: derived status (offline when no
// telemetry has been seen yet), simulation time-scale, and the latest house readings.
type liveSummary struct {
	Status      string
	TimeScale   *float64
	Temperature *float64
	Humidity    *float64
	CO2         *float64
	DLI         *float64
}

func (s *Server) liveFields(id string) liveSummary {
	live, ok := s.fleet.Get(id)
	if !ok {
		return liveSummary{Status: string(domain.StatusOffline)}
	}
	return liveSummary{
		Status:      string(live.Status),
		TimeScale:   live.TimeScale,
		Temperature: live.Temperature,
		Humidity:    live.Humidity,
		CO2:         live.CO2,
		DLI:         live.DLI,
	}
}

func (s *Server) fail(c echo.Context, err error) error {
	s.log.Error("handler error", "uri", c.Request().RequestURI, "err", err)
	return respondError(c, http.StatusInternalServerError, "internal error")
}
