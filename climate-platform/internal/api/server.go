// Package api is the platform's served HTTP surface: the operator/fleet REST API
// (platform-dashboard-rest contract) plus the WebSocket live channel (platform-dashboard-live-ws). Handlers
// read from the store and the in-memory fleet state, validate writes, and relay
// setpoint/time-scale edits down to the controllers. When OIDC is configured (2b) reads are
// open to anyone (anonymous viewer) and writes require the operator role, enforced via the
// auth middleware; when it is not, the surface runs unauthenticated on the trusted local
// Docker network (RFC-011), as in 2a.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/auth"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/config"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ingest"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/metrics"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/optimizer"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// Server wires the HTTP handlers to their collaborators.
type Server struct {
	store     *store.Store
	fleet     *state.Fleet
	ing       *ingest.Ingester
	relay     *relay.Client
	reconcile *reconcile.Reconciler
	hub       *ws.Hub
	verifier  *auth.Verifier
	// serviceAuthMode gates the optimizer POST /setpoints boundary (RFC-011): trusted_network
	// (default) accepts it untokened, oidc requires a setpoints:write service token.
	serviceAuthMode string
	// optimizer is the typed client for the Phase 3 optimizer Service API the /api/optimizer/*
	// console proxies (platform interfaces §3); nil when no optimizer URL is configured, in
	// which case the status badge synthesizes "unavailable" and the rest 404.
	optimizer *optimizer.Client
	// optimizerCadenceSecs is the fallback cadence the status badge uses before the optimizer's
	// own /health has ever reported one.
	optimizerCadenceSecs int
	// lastOptimizerCadence caches the most recent cadence the optimizer's /health reported, so a
	// synthesized "unavailable" badge still ages the last cycle against the real cadence rather
	// than the config default. Zero until the first successful health call.
	lastOptimizerCadence atomic.Int64
	metrics              *metrics.Metrics
	log                  *slog.Logger
	router               *echo.Echo
}

// New builds the server and its route tree. verifier gates the surface: nil runs
// unauthenticated (2a trusted-network posture), non-nil enforces viewer/operator auth.
// serviceAuthMode additionally gates POST /setpoints (config.ServiceAuthMode*).
func New(store *store.Store, fleet *state.Fleet, ing *ingest.Ingester, relay *relay.Client, reconciler *reconcile.Reconciler, hub *ws.Hub, verifier *auth.Verifier, serviceAuthMode string, metrics *metrics.Metrics, log *slog.Logger) *Server {
	s := &Server{store: store, fleet: fleet, ing: ing, relay: relay, reconcile: reconciler, hub: hub, verifier: verifier, serviceAuthMode: serviceAuthMode, metrics: metrics, log: log}
	router := echo.New()
	router.HideBanner = true
	router.HidePort = true
	router.Use(middleware.Recover())
	router.Use(s.metricsMiddleware())
	router.Use(s.requestLogger())
	s.routes(router)
	s.router = router
	return s
}

func (s *Server) routes(router *echo.Echo) {
	router.GET("/healthz", func(c echo.Context) error { return c.JSON(http.StatusOK, map[string]string{"status": "ok"}) })

	// Prometheus scrapes /metrics directly over the internal network (operations §1); it
	// sits outside the /api auth group — unauthenticated, and never exposed via the proxy.
	if s.metrics != nil {
		router.GET("/metrics", echo.WrapHandler(s.metrics.Handler()))
	}

	// When OIDC is configured, reads (REST GETs + the WS handshake) are open to anyone,
	// including anonymous visitors; writes are additionally gated to the operator role
	// (platform security §4). OptionalAuth validates a token when present so an operator's
	// claims reach the write gate and the audit trail. When the verifier is nil both are
	// pass-throughs — the unauthenticated 2a posture (RFC-011).
	api := router.Group("/api")
	api.Use(auth.OptionalAuth(s.verifier))
	operator := auth.RequireOperator(s.verifier)
	// POST /setpoints is the optimizer's service write path: open in trusted_network mode,
	// gated to a setpoints:write service token (or operator) in oidc mode (RFC-011).
	setpointsWriter := auth.RequireSetpointsWrite(s.verifier, s.serviceAuthMode == config.ServiceAuthModeOIDC)

	api.GET("/greenhouses", s.listGreenhouses)
	api.POST("/greenhouses", s.registerGreenhouse, operator)
	api.GET("/greenhouses/sparklines", s.getFleetSparklines) // static segment resolves before :id
	api.GET("/greenhouses/:id", s.getGreenhouse)
	api.DELETE("/greenhouses/:id", s.retireGreenhouse, operator)
	api.PATCH("/greenhouses/:id/setpoints", s.editSetpoints, operator)
	api.POST("/greenhouses/:id/setpoints", s.submitSetpoints, setpointsWriter)
	api.GET("/greenhouses/:id/telemetry", s.getTelemetry)
	api.GET("/greenhouses/:id/analytics", s.getAnalytics)
	// (3) The optimizer's planning-context read path (platform-optimizer-planning-rest). An
	// unauthenticated read like the rest of the surface: it carries no authority, and RFC-011
	// scopes service auth to the write boundaries.
	api.GET("/greenhouses/:id/planning-context", s.getPlanningContext)
	api.GET("/greenhouses/:id/sim/time-scale", s.getTimeScale)
	api.PATCH("/greenhouses/:id/sim/time-scale", s.setTimeScale, operator)
	api.PATCH("/sim/time-scale", s.setFleetTimeScale, operator)

	// Crop profiles + assignment (2b). Reads browse the library; writes are operator-only.
	api.GET("/profiles", s.listProfiles)
	api.POST("/profiles", s.createProfile, operator)
	api.GET("/profiles/:profileID", s.getProfile)
	api.PATCH("/profiles/:profileID", s.updateProfile, operator)
	api.DELETE("/profiles/:profileID", s.deleteProfile, operator)
	api.GET("/greenhouses/:id/assignment", s.getAssignment)
	api.PUT("/greenhouses/:id/assignment", s.setAssignment, operator)

	api.GET("/events", s.listEvents)
	api.GET("/stream", s.stream) // WebSocket live fan-out (platform-dashboard-live-ws)

	// (3) Optimizer operator console: the Go API proxies/aggregates the optimizer's own
	// Service API into the versioned dashboard surface (platform interfaces §3). Reads are
	// viewer-open; the mutations are operator-gated like the rest of the write surface. The
	// inward Go-API → optimizer hop forwards the caller's token so the optimizer re-checks the
	// operator role itself in oidc mode.
	opt := api.Group("/optimizer")
	opt.GET("/status", s.getOptimizerStatus)
	opt.GET("/fleet", s.getOptimizerFleet)
	opt.GET("/escalations", s.listOptimizerEscalations)
	opt.POST("/escalations/:escalationID/resolve", s.resolveOptimizerEscalation, operator)
	opt.GET("/model", s.getOptimizerModel)
	opt.POST("/model", s.setOptimizerModel, operator)
	opt.GET("/enabled", s.getOptimizerEnabled)
	opt.POST("/enabled", s.setOptimizerEnabled, operator)
	opt.GET("/greenhouses/:id/plan", s.getOptimizerPlan)
	opt.POST("/greenhouses/:id/cycles", s.triggerOptimizerCycle, operator)
	opt.GET("/greenhouses/:id/enabled", s.getGreenhouseOptimizerEnabled)
	opt.POST("/greenhouses/:id/enabled", s.setGreenhouseOptimizerEnabled, operator)
}

// WithOptimizer wires the Phase 3 optimizer console. It is a post-construction setter rather
// than a New parameter so the many existing New callers stay untouched and the optimizer is
// an opt-in surface: without it the /api/optimizer/* routes still register, but the status
// badge synthesizes "unavailable" and the rest 404. Returns the server for chaining.
func (s *Server) WithOptimizer(client *optimizer.Client, cadenceSecs int) *Server {
	s.optimizer = client
	s.optimizerCadenceSecs = cadenceSecs
	return s
}

// Handler exposes the underlying http.Handler (for tests / embedding behind a proxy).
func (s *Server) Handler() http.Handler { return s.router }

// Start serves until Shutdown; returns http.ErrServerClosed on graceful stop.
func (s *Server) Start(addr string) error { return s.router.Start(addr) }

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error { return s.router.Shutdown(ctx) }

func (s *Server) stream(c echo.Context) error {
	s.hub.Handle(c.Response(), c.Request())
	return nil
}

// metricsMiddleware records each served request's latency into the HTTP histogram,
// labelled by the route template (c.Path(), e.g. /api/greenhouses/:id) rather than the
// raw URI so path parameters do not explode label cardinality.
func (s *Server) metricsMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			err := next(c)
			route := c.Path()
			if route == "" {
				route = "unmatched"
			}
			s.metrics.ObserveHTTP(c.Request().Method, route, c.Response().Status, time.Since(start))
			return err
		}
	}
}

func (s *Server) requestLogger() echo.MiddlewareFunc {
	return middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogStatus: true, LogMethod: true, LogURI: true, LogLatency: true,
		LogValuesFunc: func(_ echo.Context, values middleware.RequestLoggerValues) error {
			s.log.Info("request", "method", values.Method, "uri", values.URI, "status", values.Status, "latency", values.Latency.String())
			return nil
		},
	})
}

// --- response helpers ---

func respondValidation(c echo.Context, ve *valError) error {
	return c.JSON(http.StatusUnprocessableEntity, ve.body())
}

func respondNotFound(c echo.Context, msg string) error {
	return c.JSON(http.StatusNotFound, errorBody{Error: msg})
}

func respondError(c echo.Context, status int, msg string) error {
	return c.JSON(status, errorBody{Error: msg})
}

// fmtTS renders a timestamp as RFC 3339 UTC with millisecond precision (RFC-007).
func fmtTS(ts time.Time) string {
	return ts.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
