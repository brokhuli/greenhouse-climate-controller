// Package api is the platform's served HTTP surface: the operator/fleet REST API
// (frontend-rest contract) plus the WebSocket live channel (frontend-ws). Handlers
// read from the store and the in-memory fleet state, validate writes, and relay
// setpoint/time-scale edits down to the controllers. In 2a the surface is
// unauthenticated on the trusted local Docker network (RFC-011).
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ingest"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// Server wires the HTTP handlers to their collaborators.
type Server struct {
	store  *store.Store
	fleet  *state.Fleet
	ing    *ingest.Ingester
	relay  *relay.Client
	hub    *ws.Hub
	log    *slog.Logger
	router *echo.Echo
}

// New builds the server and its route tree.
func New(store *store.Store, fleet *state.Fleet, ing *ingest.Ingester, relay *relay.Client, hub *ws.Hub, log *slog.Logger) *Server {
	s := &Server{store: store, fleet: fleet, ing: ing, relay: relay, hub: hub, log: log}
	router := echo.New()
	router.HideBanner = true
	router.HidePort = true
	router.Use(middleware.Recover())
	router.Use(s.requestLogger())
	s.routes(router)
	s.router = router
	return s
}

func (s *Server) routes(router *echo.Echo) {
	router.GET("/healthz", func(c echo.Context) error { return c.JSON(http.StatusOK, map[string]string{"status": "ok"}) })

	api := router.Group("/api")
	api.GET("/greenhouses", s.listGreenhouses)
	api.POST("/greenhouses", s.registerGreenhouse)
	api.GET("/greenhouses/sparklines", s.getFleetSparklines) // static segment resolves before :id
	api.GET("/greenhouses/:id", s.getGreenhouse)
	api.DELETE("/greenhouses/:id", s.retireGreenhouse)
	api.PATCH("/greenhouses/:id/setpoints", s.editSetpoints)
	api.GET("/greenhouses/:id/telemetry", s.getTelemetry)
	api.GET("/greenhouses/:id/analytics", s.getAnalytics)
	api.GET("/greenhouses/:id/sim/time-scale", s.getTimeScale)
	api.PATCH("/greenhouses/:id/sim/time-scale", s.setTimeScale)
	api.PATCH("/sim/time-scale", s.setFleetTimeScale)
	api.GET("/events", s.listEvents)
	api.GET("/stream", s.stream) // WebSocket live fan-out (frontend-ws)
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
