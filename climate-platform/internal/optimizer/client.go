// Package optimizer is the platform's typed client for the Phase 3 optimizer's FastAPI
// Service API. The Go API proxies and aggregates that internal surface into the versioned
// platform-dashboard-rest optimizer console (platform interfaces §3), so the SPA reaches the
// optimizer through the one hub and never opens a second origin.
//
// This is a sideways service-to-service hop, distinct from internal/relay (the downward
// controller path): it has its own base URL, its own timeout, and its own typed shapes
// mirroring the optimizer's service/schemas.py. The mapping from these shapes to the
// frontend contract lives in the api package, not here — this package only speaks the
// optimizer's own language.
package optimizer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client calls the optimizer's Service API over the internal Docker network.
type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a client against the optimizer's base URL (e.g. http://optimizer:8000) with a
// per-call timeout.
func New(baseURL string, timeout time.Duration) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: timeout},
	}
}

// StatusError is a non-2xx response from the optimizer. The handlers inspect Code to pass an
// operator-meaningful status through (a 409 from a cycle already in flight, a 400 from an
// out-of-allowlist model, a 404 for an unknown greenhouse/escalation) rather than collapsing
// every upstream failure into a 502.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("optimizer responded %d: %s", e.Code, e.Body)
}

// StatusCode reports the upstream status of an error, or 0 when err is not a StatusError
// (a transport failure — the optimizer was unreachable, not merely unhappy).
func StatusCode(err error) int {
	var se *StatusError
	if errors.As(err, &se) {
		return se.Code
	}
	return 0
}

// do issues a request and decodes a JSON response into out (out may be nil to discard the
// body). token, when non-empty, is forwarded as the Authorization header so the optimizer's
// own operator-role re-check passes in oidc mode (interfaces §authenticating the mutating
// endpoints); on the trusted_network default it is empty and the call is untokened.
func (c *Client) do(ctx context.Context, method, path, token string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal optimizer request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &StatusError{Code: resp.StatusCode, Body: string(payload)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("decode optimizer response: %w", err)
	}
	return nil
}

// Health fetches the optimizer's internal /health (spec 09), the source the Go API derives
// the frontend status badge from.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var health Health
	err := c.do(ctx, http.MethodGet, "/health", "", nil, &health)
	return health, err
}

// Fleet fetches the per-greenhouse latest outcomes + site rollup in one read.
func (c *Client) Fleet(ctx context.Context) (Fleet, error) {
	var fleet Fleet
	err := c.do(ctx, http.MethodGet, "/api/optimizer/fleet", "", nil, &fleet)
	return fleet, err
}

// LatestPlan fetches one greenhouse's latest PlanRecord; a 404 (no plan yet) surfaces as a
// StatusError the handler maps to its own 404.
func (c *Client) LatestPlan(ctx context.Context, greenhouseID string) (PlanRecord, error) {
	var record PlanRecord
	err := c.do(ctx, http.MethodGet, "/api/optimizer/greenhouses/"+greenhouseID+"/plans/latest", "", nil, &record)
	return record, err
}

// TriggerCycle asks the optimizer to plan one greenhouse now. The optimizer returns the
// resulting PlanRecord (202); a 409 (disabled or already planning) surfaces as a StatusError.
func (c *Client) TriggerCycle(ctx context.Context, greenhouseID, token string, req CycleRequest) (PlanRecord, error) {
	var record PlanRecord
	err := c.do(ctx, http.MethodPost, "/api/optimizer/greenhouses/"+greenhouseID+"/cycles", token, req, &record)
	return record, err
}

// Escalations lists the open (awaiting-review) escalation set, triage-ordered upstream.
func (c *Client) Escalations(ctx context.Context) ([]Escalation, error) {
	var escalations []Escalation
	err := c.do(ctx, http.MethodGet, "/api/optimizer/escalations", "", nil, &escalations)
	return escalations, err
}

// ResolveEscalation closes an open escalation as the operator resolution; a 404 (already
// closed / unknown) surfaces as a StatusError.
func (c *Client) ResolveEscalation(ctx context.Context, escalationID, token string, req ResolveRequest) (Escalation, error) {
	var escalation Escalation
	err := c.do(ctx, http.MethodPost, "/api/optimizer/escalations/"+escalationID+"/resolve", token, req, &escalation)
	return escalation, err
}

// Model fetches the active backend + the active provider's runtime allowlist.
func (c *Client) Model(ctx context.Context) (ModelState, error) {
	var model ModelState
	err := c.do(ctx, http.MethodGet, "/api/optimizer/model", "", nil, &model)
	return model, err
}

// SetModel switches the active model within the allowlist; a 400 (not allowlisted) surfaces
// as a StatusError.
func (c *Client) SetModel(ctx context.Context, token string, req ModelSelection) (ModelState, error) {
	var model ModelState
	err := c.do(ctx, http.MethodPost, "/api/optimizer/model", token, req, &model)
	return model, err
}

// Enabled fetches the service-wide enable / read-only state.
func (c *Client) Enabled(ctx context.Context) (EnableState, error) {
	var state EnableState
	err := c.do(ctx, http.MethodGet, "/api/optimizer/enabled", "", nil, &state)
	return state, err
}

// SetEnabled pauses or resumes the whole optimizer.
func (c *Client) SetEnabled(ctx context.Context, token string, req EnableRequest) (EnableState, error) {
	var state EnableState
	err := c.do(ctx, http.MethodPost, "/api/optimizer/enabled", token, req, &state)
	return state, err
}

// GreenhouseEnabled fetches one greenhouse's enable state.
func (c *Client) GreenhouseEnabled(ctx context.Context, greenhouseID string) (GreenhouseEnableState, error) {
	var state GreenhouseEnableState
	err := c.do(ctx, http.MethodGet, "/api/optimizer/greenhouses/"+greenhouseID+"/enabled", "", nil, &state)
	return state, err
}

// SetGreenhouseEnabled pauses or resumes one greenhouse.
func (c *Client) SetGreenhouseEnabled(ctx context.Context, greenhouseID, token string, req EnableRequest) (GreenhouseEnableState, error) {
	var state GreenhouseEnableState
	err := c.do(ctx, http.MethodPost, "/api/optimizer/greenhouses/"+greenhouseID+"/enabled", token, req, &state)
	return state, err
}
