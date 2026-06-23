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
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("PLATFORM_DATABASE_URL is required")
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
