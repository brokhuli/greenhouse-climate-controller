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
	summaries := make([]greenhouseSummaryDTO, 0, len(greenhouses))
	for _, greenhouse := range greenhouses {
		summaries = append(summaries, s.summaryOf(greenhouse))
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
	return c.JSON(http.StatusCreated, s.summaryOf(store.Greenhouse{ID: req.ID, DisplayName: req.DisplayName, Crop: req.Crop}))
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
	resp, err := s.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, "/setpoints", endpoint.BearerToken, nil)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	if resp.Status != http.StatusOK {
		return respondError(c, http.StatusServiceUnavailable, "controller did not return setpoints")
	}
	status, timeScale, _ := s.liveFields(id)
	return c.JSON(http.StatusOK, greenhouseDetailDTO{
		ID:          greenhouse.ID,
		DisplayName: greenhouse.DisplayName,
		Crop:        greenhouse.Crop,
		Status:      status,
		Drift:       false,
		TimeScale:   timeScale,
		Setpoints:   resp.Body,
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

// summaryOf overlays the in-memory live state onto a registry row.
func (s *Server) summaryOf(greenhouse store.Greenhouse) greenhouseSummaryDTO {
	status, timeScale, temperature := s.liveFields(greenhouse.ID)
	return greenhouseSummaryDTO{
		ID:          greenhouse.ID,
		DisplayName: greenhouse.DisplayName,
		Crop:        greenhouse.Crop,
		Status:      status,
		Drift:       false,
		TimeScale:   timeScale,
		Climate:     climateDTO{Temperature: temperature, SetpointTemperature: nil},
	}
}

// liveFields returns a greenhouse's derived status, time-scale, and latest temperature,
// defaulting to offline when no telemetry has been seen yet.
func (s *Server) liveFields(id string) (status string, timeScale, temperature *float64) {
	live, ok := s.fleet.Get(id)
	if !ok {
		return string(domain.StatusOffline), nil, nil
	}
	return string(live.Status), live.TimeScale, live.Temperature
}

func (s *Server) fail(c echo.Context, err error) error {
	s.log.Error("handler error", "uri", c.Request().RequestURI, "err", err)
	return respondError(c, http.StatusInternalServerError, "internal error")
}
