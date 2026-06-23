package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"

	"github.com/labstack/echo/v4"
)

// getTimeScale relays the controller's current simulated-clock speed (sim-only). The
// controller's response passes through unchanged: 200 TimeScale, or 404 on real hardware.
func (s *Server) getTimeScale(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	endpoint, found, err := s.store.GetEndpoint(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "greenhouse not found")
	}
	resp, err := s.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, "/sim/time-scale", endpoint.BearerToken, nil)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	return c.JSONBlob(resp.Status, resp.Body)
}

// setTimeScale relays a simulated-clock speed change to one controller's PUT
// /sim/time-scale, passing its response through (200 TimeScale / 422 / 404).
func (s *Server) setTimeScale(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	endpoint, found, err := s.store.GetEndpoint(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "greenhouse not found")
	}
	scale, verr := readScale(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	body, _ := json.Marshal(map[string]float64{"scale": *scale})
	resp, err := s.relay.Do(ctx, http.MethodPut, endpoint.RESTBaseURL, "/sim/time-scale", endpoint.BearerToken, body)
	if err != nil {
		return respondError(c, http.StatusServiceUnavailable, "controller unreachable")
	}
	return c.JSONBlob(resp.Status, resp.Body)
}

// setFleetTimeScale fans the requested speed out to every greenhouse as N independent
// per-controller writes (no shared clock) and reports the per-greenhouse outcome.
func (s *Server) setFleetTimeScale(c echo.Context) error {
	ctx := c.Request().Context()
	scale, verr := readScale(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	endpoints, err := s.store.ListEndpoints(ctx)
	if err != nil {
		return s.fail(c, err)
	}
	ids := make([]string, 0, len(endpoints))
	for id := range endpoints {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	body, _ := json.Marshal(map[string]float64{"scale": *scale})
	results := make([]fleetTimeScaleEntryDTO, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			results[i] = s.relayFleetScale(ctx, id, endpoints[id].RESTBaseURL, endpoints[id].BearerToken, body)
		}(i, id)
	}
	wg.Wait()

	return c.JSON(http.StatusOK, fleetTimeScaleResultDTO{RequestedScale: *scale, Results: results})
}

func (s *Server) relayFleetScale(ctx context.Context, id, baseURL string, token *string, body []byte) fleetTimeScaleEntryDTO {
	entry := fleetTimeScaleEntryDTO{GreenhouseID: id}
	resp, err := s.relay.Do(ctx, http.MethodPut, baseURL, "/sim/time-scale", token, body)
	switch {
	case err != nil:
		entry.Detail = strPtr("offline")
	case resp.Status == http.StatusOK:
		var parsed struct {
			Scale float64 `json:"scale"`
		}
		if json.Unmarshal(resp.Body, &parsed) == nil {
			scale := parsed.Scale
			entry.Scale = &scale
		}
		entry.Applied = true
	case resp.Status == http.StatusNotFound:
		entry.Detail = strPtr("not a simulated backend")
	default:
		entry.Detail = strPtr(fmt.Sprintf("controller returned %d", resp.Status))
	}
	return entry
}

// readScale reads and validates the {scale} body of a time-scale request.
func readScale(c echo.Context) (*float64, *valError) {
	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return nil, &valError{Field: "scale", Bound: "required", Value: nil}
	}
	var patch timeScalePatchDTO
	if err := json.Unmarshal(raw, &patch); err != nil {
		return nil, &valError{Field: "scale", Bound: "number 0.25..8.0", Value: nil}
	}
	if verr := validateScale(patch.Scale); verr != nil {
		return nil, verr
	}
	return patch.Scale, nil
}

func strPtr(s string) *string { return &s }
