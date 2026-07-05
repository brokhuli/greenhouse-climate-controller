// Package config loads the platform service configuration from the environment.
//
// Per operations §2 the platform's own configuration (DB DSN, MQTT broker address,
// ports) is supplied via environment variables / the Compose file — never a
// per-greenhouse file (that is the controller's TOML). Per-greenhouse data lives in
// the registry, not here.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Service-auth modes for the optimizer → POST /setpoints write boundary (RFC-011). The mode is
// dormant by default: trusted_network accepts the internal call without a service token (the
// committed single-host posture), oidc requires a Keycloak setpoints:write token.
const (
	ServiceAuthModeTrustedNetwork = "trusted_network"
	ServiceAuthModeOIDC           = "oidc"
)

// Config is the resolved platform service configuration.
type Config struct {
	// DatabaseURL is the TimescaleDB/PostgreSQL DSN (pgx).
	DatabaseURL string
	// MQTTBrokerURL is the MQTT broker address (e.g. tcp://mqtt:1883).
	MQTTBrokerURL string
	// HTTPAddr is the address the REST + WebSocket server binds (e.g. :8080).
	HTTPAddr string
	// RetentionDays is the telemetry retention horizon; raw history older than this
	// is dropped (ingestion §5, default 30).
	RetentionDays int
	// IngestBufferSize bounds the in-memory ingest buffer; under sustained
	// backpressure the oldest frames are shed (ingestion §6).
	IngestBufferSize int
	// OfflineAfter is how long without contact (scaled by time_scale) marks a
	// greenhouse offline (ingestion §4 liveness).
	OfflineAfter time.Duration
	// RelayTimeout bounds a downward controller REST call.
	RelayTimeout time.Duration
	// ReconcileInterval is the reconciliation loop cadence: how often the platform
	// re-asserts intended state and checks for drift (crop-profiles §3, P2-REL-1).
	ReconcileInterval time.Duration
	// ReassertJitter bounds the random stagger between greenhouses within a cycle, so a
	// shared reconnect does not thunder the controllers' REST APIs.
	ReassertJitter time.Duration
	// DriftMaxRetries is how many consecutive failed deliveries/corrections the reconciler
	// makes before backing off and leaving drift surfaced for the operator.
	DriftMaxRetries int
	// ProvenancePruneDays is the window past which superseded setpoint revisions are pruned;
	// the current revision per greenhouse is always kept (platform data model §2).
	ProvenancePruneDays int
	// OIDCIssuerURL is the token issuer the API trusts (the `iss` claim, browser-facing —
	// e.g. http://localhost:8080/auth/realms/greenhouse). When empty, OIDC is disabled and
	// the API runs unauthenticated on the trusted network (RFC-011); when set, human
	// viewer/operator auth is enforced (platform security §2, P2-SEC-1).
	OIDCIssuerURL string
	// OIDCDiscoveryURL is where the API fetches the discovery document / JWKS on the internal
	// network (e.g. http://auth:8080/auth/realms/greenhouse). Defaults to OIDCIssuerURL; set
	// it separately when Keycloak sits behind the proxy under a different internal address.
	OIDCDiscoveryURL string
	// OIDCAudience, when set, is required in the token's `aud` (the Keycloak audience mapper
	// adds it). Empty skips the audience check.
	OIDCAudience string
	// ServiceAuthMode gates the optimizer → POST /setpoints write boundary (RFC-011):
	// trusted_network (default) accepts the internal call untokened; oidc requires a Keycloak
	// setpoints:write client-credentials token, validated on the same path as human tokens. The
	// oidc mode therefore requires OIDCIssuerURL to be set (platform security §5).
	ServiceAuthMode string
}

// Load resolves the configuration from the environment, applying defaults. It returns
// an error only when a required value is missing and has no sensible default.
func Load() (Config, error) {
	cfg := Config{
		DatabaseURL:      env("PLATFORM_DATABASE_URL", ""),
		MQTTBrokerURL:    env("PLATFORM_MQTT_BROKER_URL", "tcp://localhost:1883"),
		HTTPAddr:         env("PLATFORM_HTTP_ADDR", ":8080"),
		RetentionDays:    envInt("PLATFORM_RETENTION_DAYS", 30),
		IngestBufferSize: envInt("PLATFORM_INGEST_BUFFER", 4096),
		OfflineAfter:     time.Duration(envInt("PLATFORM_OFFLINE_AFTER_SECS", 10)) * time.Second,
		RelayTimeout:     time.Duration(envInt("PLATFORM_RELAY_TIMEOUT_SECS", 5)) * time.Second,

		ReconcileInterval:   time.Duration(envInt("PLATFORM_RECONCILE_INTERVAL_SECS", 30)) * time.Second,
		ReassertJitter:      time.Duration(envInt("PLATFORM_REASSERT_JITTER_SECS", 3)) * time.Second,
		DriftMaxRetries:     envInt("PLATFORM_DRIFT_MAX_RETRIES", 5),
		ProvenancePruneDays: envInt("PLATFORM_PROVENANCE_PRUNE_DAYS", 30),

		OIDCIssuerURL:    env("PLATFORM_OIDC_ISSUER_URL", ""),
		OIDCDiscoveryURL: env("PLATFORM_OIDC_DISCOVERY_URL", ""),
		OIDCAudience:     env("PLATFORM_OIDC_AUDIENCE", ""),

		ServiceAuthMode: env("PLATFORM_SERVICE_AUTH_MODE", ServiceAuthModeTrustedNetwork),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("PLATFORM_DATABASE_URL is required")
	}
	switch cfg.ServiceAuthMode {
	case ServiceAuthModeTrustedNetwork:
	case ServiceAuthModeOIDC:
		// oidc mode reuses the human OIDC verifier to validate the service token, so it cannot be
		// enforced without an issuer to validate against.
		if cfg.OIDCIssuerURL == "" {
			return Config{}, fmt.Errorf("PLATFORM_SERVICE_AUTH_MODE=oidc requires PLATFORM_OIDC_ISSUER_URL")
		}
	default:
		return Config{}, fmt.Errorf("PLATFORM_SERVICE_AUTH_MODE must be %q or %q, got %q", ServiceAuthModeTrustedNetwork, ServiceAuthModeOIDC, cfg.ServiceAuthMode)
	}
	return cfg, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
