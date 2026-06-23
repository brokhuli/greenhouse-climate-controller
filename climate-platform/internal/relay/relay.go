// Package relay is the platform's thin client to a controller's REST API — the
// control-down path (RFC-005). In 2a it forwards an operator's setpoint edit (and the
// sim-only time-scale knob) to the controller and returns the controller's response
// verbatim, so a controller's 200/404/422 propagates back to the caller unchanged.
package relay

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client calls controller REST endpoints.
type Client struct {
	http *http.Client
}

// New builds a relay client with a per-call timeout.
func New(timeout time.Duration) *Client {
	return &Client{http: &http.Client{Timeout: timeout}}
}

// Response is a controller's HTTP reply, captured for transparent passthrough.
type Response struct {
	Status int
	Body   []byte
}

// Do issues method baseURL+path with the optional bearer token and body, returning the
// controller's status and body. A non-nil error means the controller was unreachable
// (transport failure), distinct from an HTTP error status it returned.
func (c *Client) Do(ctx context.Context, method, baseURL, path string, token *string, body []byte) (Response, error) {
	url := strings.TrimRight(baseURL, "/") + path
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return Response{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != nil && *token != "" {
		req.Header.Set("Authorization", "Bearer "+*token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return Response{}, err
	}
	return Response{Status: resp.StatusCode, Body: data}, nil
}
