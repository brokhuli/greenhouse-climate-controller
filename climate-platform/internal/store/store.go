// Package store is the platform's persistence layer over one TimescaleDB
// (PostgreSQL + extension) instance: the relational registry plus the append-only
// telemetry hypertables (platform data model). Queries are hand-written SQL on pgx —
// explicit and type-checked at the driver, no ORM — and schema changes are versioned
// golang-migrate files embedded into the binary and run on startup (the startup gate:
// a failed migration blocks the API from coming up, operations §2).
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5" // registers the pgx5 database driver
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// hypertables are the telemetry tables converted to TimescaleDB hypertables and bound
// by the retention policy.
var hypertables = []string{"sensor_readings", "actuator_states", "events"}

// Store wraps a pgx connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// Open connects the pool and verifies connectivity.
func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Pool exposes the underlying pool (used by tests).
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Migrate runs all pending up-migrations. It is the startup gate: any failure other
// than "no change" is returned and should abort boot.
func Migrate(dsn string) error {
	source, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("open migration source: %w", err)
	}
	migrator, err := migrate.NewWithSourceInstance("iofs", source, migrateURL(dsn))
	if err != nil {
		return fmt.Errorf("init migrate: %w", err)
	}
	defer func() { _, _ = migrator.Close() }()
	if err := migrator.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}

// EnsureTimescale converts the telemetry tables to hypertables (idempotent) and sets
// the retention policy to retentionDays. Run after Migrate. The retention horizon is
// applied here, from config, rather than baked into a migration literal — so a
// deploy-time change to PLATFORM_RETENTION_DAYS takes effect on the next boot
// (ingestion §5).
func (s *Store) EnsureTimescale(ctx context.Context, retentionDays int) error {
	for _, table := range hypertables {
		query := fmt.Sprintf(`SELECT create_hypertable('%s', 'ts', if_not_exists => TRUE)`, table)
		if _, err := s.pool.Exec(ctx, query); err != nil {
			return fmt.Errorf("create_hypertable %s: %w", table, err)
		}
	}
	for _, table := range hypertables {
		if _, err := s.pool.Exec(ctx, fmt.Sprintf(`SELECT remove_retention_policy('%s', if_exists => TRUE)`, table)); err != nil {
			return fmt.Errorf("remove_retention_policy %s: %w", table, err)
		}
		query := fmt.Sprintf(`SELECT add_retention_policy('%s', INTERVAL '%d days')`, table, retentionDays)
		if _, err := s.pool.Exec(ctx, query); err != nil {
			return fmt.Errorf("add_retention_policy %s: %w", table, err)
		}
	}
	return nil
}

// migrateURL rewrites a libpq/pgx DSN to the scheme golang-migrate's pgx/v5 driver
// registers ("pgx5"). It accepts postgres://, postgresql://, or an already-pgx5 URL.
func migrateURL(dsn string) string {
	for _, scheme := range []string{"postgres://", "postgresql://", "pgx5://"} {
		if strings.HasPrefix(dsn, scheme) {
			return "pgx5://" + strings.TrimPrefix(dsn, scheme)
		}
	}
	return dsn
}
