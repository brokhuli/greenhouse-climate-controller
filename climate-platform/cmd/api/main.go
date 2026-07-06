// Command api is the Phase 2 platform service: it migrates and opens TimescaleDB,
// ingests controller telemetry off MQTT, serves the operator/fleet REST API plus the
// WebSocket live channel, and relays setpoint edits down to controllers. Everything
// runs in one process (the hub model, platform architecture §2).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/api"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/auth"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/config"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ingest"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/metrics"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Migration-on-startup is the startup gate: a failed migration blocks boot
	// (operations §2).
	if err := store.Migrate(cfg.DatabaseURL); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer db.Close()
	if err := db.EnsureTimescale(ctx, cfg.RetentionDays); err != nil {
		return fmt.Errorf("ensure timescale: %w", err)
	}
	if err := db.EnsureProvenancePrune(ctx, cfg.ProvenancePruneDays); err != nil {
		return fmt.Errorf("ensure provenance prune: %w", err)
	}

	// Platform-health metrics (operations §1): the registry is built here and injected into
	// the components that record; the scrape-time collectors are registered as their data
	// sources come up. Served at /metrics for Prometheus.
	met := metrics.New()
	met.RegisterDatastore(func() metrics.PoolStat {
		st := db.Pool().Stat()
		return metrics.PoolStat{
			Acquired:     st.AcquiredConns(),
			Idle:         st.IdleConns(),
			Total:        st.TotalConns(),
			Max:          st.MaxConns(),
			Constructing: st.ConstructingConns(),
		}
	}, db)

	fleet := state.NewFleet(cfg.OfflineAfter)
	met.RegisterFleet(fleet)
	hub := ws.NewHub(log)
	ing := ingest.New(db, fleet, hub, met, log, cfg.MQTTBrokerURL, cfg.IngestBufferSize, cfg.OfflineAfter)
	met.RegisterIngestDropped(func() float64 { return float64(ing.Dropped()) })

	// Seed the ingester's known-greenhouse set so existing registrations route on boot.
	endpoints, err := db.ListEndpoints(ctx)
	if err != nil {
		return fmt.Errorf("load registry: %w", err)
	}
	topicRoots := make(map[string]string, len(endpoints))
	for id, endpoint := range endpoints {
		topicRoots[id] = endpoint.MQTTTopicRoot
	}
	ing.Seed(topicRoots)
	if err := ing.Start(ctx); err != nil {
		return fmt.Errorf("start ingester: %w", err)
	}

	relayClient := relay.New(cfg.RelayTimeout)
	reconciler := reconcile.New(db, relayClient, fleet, hub, met, log, reconcile.Config{
		Interval:   cfg.ReconcileInterval,
		Jitter:     cfg.ReassertJitter,
		MaxRetries: cfg.DriftMaxRetries,
	})
	reconciler.Start(ctx)

	// OIDC verifier: nil (and thus an unauthenticated surface) unless PLATFORM_OIDC_ISSUER_URL
	// is set. Discovery retries a slow-to-start Keycloak (platform security §2, RFC-011).
	verifier, err := auth.NewVerifier(ctx, cfg.OIDCIssuerURL, cfg.OIDCDiscoveryURL, cfg.OIDCAudience)
	if err != nil {
		return fmt.Errorf("oidc verifier: %w", err)
	}

	server := api.New(db, fleet, ing, relayClient, reconciler, hub, verifier, cfg.ServiceAuthMode, met, log)

	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Start(cfg.HTTPAddr) }()
	log.Info("platform started", "addr", cfg.HTTPAddr, "broker", cfg.MQTTBrokerURL, "retention_days", cfg.RetentionDays, "auth", verifier != nil, "service_auth_mode", cfg.ServiceAuthMode)

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		log.Info("shutting down")
		return server.Shutdown(shutdownCtx)
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
