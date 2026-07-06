package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/config"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/metrics"
)

// TestMetricsEndpoint verifies /metrics is served (unauthenticated, at the root) and that
// the HTTP middleware records a served request under its route-template label.
func TestMetricsEndpoint(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(nil, nil, nil, nil, nil, nil, nil, config.ServiceAuthModeTrustedNetwork, metrics.New(), logger)

	// One request through the chain produces an http_request_duration observation.
	health := httptest.NewRecorder()
	srv.Handler().ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("/healthz status = %d, want 200", health.Code)
	}

	scrape := httptest.NewRecorder()
	srv.Handler().ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if scrape.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, want 200", scrape.Code)
	}
	body := scrape.Body.String()
	if !strings.Contains(body, "platform_http_request_duration_seconds") {
		t.Errorf("exposition missing http histogram:\n%s", body)
	}
	// The route label is the template, not the raw URI (cardinality bound).
	if !strings.Contains(body, `route="/healthz"`) {
		t.Errorf(`exposition missing route="/healthz":\n%s`, body)
	}
}

// TestMetricsDisabledWhenNil confirms a nil metrics handle leaves /metrics unregistered
// (the 2a posture) while requests still serve.
func TestMetricsDisabledWhenNil(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(nil, nil, nil, nil, nil, nil, nil, config.ServiceAuthModeTrustedNetwork, nil, logger)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/metrics status = %d, want 404 when metrics disabled", rec.Code)
	}
}
