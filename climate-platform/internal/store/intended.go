package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// Delivery statuses recorded in reconciliation_state: whether the current intended
// revision has reached the controller (crop-profiles §3).
const (
	DeliveryPending   = "pending"   // never yet attempted
	DeliveryDelivered = "delivered" // controller acknowledged the current revision
	DeliveryDeferred  = "deferred"  // held because the controller is offline
	DeliveryRejected  = "rejected"  // controller refused / the relay failed
)

// ReconState is the per-greenhouse reconciliation bookkeeping row.
type ReconState struct {
	GreenhouseID          string
	LastDeliveredRevision *int64
	DeliveryStatus        string
	Drift                 bool
	DriftFirstSeen        *time.Time
	DriftLastSeen         *time.Time
	LastAttemptAt         *time.Time
	FailCount             int
}

// AppendRevision appends a new intended-state revision for a greenhouse and returns the
// assigned monotonic revision number. The revision is (current max + 1) computed inside the
// insert so the (greenhouse_id, revision) key stays dense and gap-free.
func (s *Store) AppendRevision(ctx context.Context, revision domain.SetpointRevision) (int64, error) {
	setpoints, err := json.Marshal(revision.Setpoints)
	if err != nil {
		return 0, fmt.Errorf("marshal setpoints: %w", err)
	}
	var assigned int64
	err = s.pool.QueryRow(ctx,
		`INSERT INTO setpoint_revisions (greenhouse_id, revision, source, actor, reason, setpoints)
		 SELECT $1, COALESCE(MAX(revision), 0) + 1, $2, $3, $4, $5
		 FROM setpoint_revisions WHERE greenhouse_id=$1
		 RETURNING revision`,
		revision.GreenhouseID, string(revision.Source), revision.Actor, revision.Reason, string(setpoints)).
		Scan(&assigned)
	if err != nil {
		return 0, err
	}
	return assigned, nil
}

// CurrentRevision returns a greenhouse's latest (current) intended-state revision; found is
// false when the greenhouse has none yet.
func (s *Store) CurrentRevision(ctx context.Context, greenhouseID string) (domain.SetpointRevision, bool, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT greenhouse_id, revision, source, actor, reason, setpoints, created_at
		 FROM setpoint_revisions WHERE greenhouse_id=$1 ORDER BY revision DESC LIMIT 1`, greenhouseID)
	if err != nil {
		return domain.SetpointRevision{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return domain.SetpointRevision{}, false, rows.Err()
	}
	revision, err := scanRevision(rows)
	if err != nil {
		return domain.SetpointRevision{}, false, err
	}
	return revision, true, nil
}

// GetReconState returns a greenhouse's reconciliation bookkeeping; found is false when no
// row exists yet (nothing has been applied).
func (s *Store) GetReconState(ctx context.Context, greenhouseID string) (ReconState, bool, error) {
	var recon ReconState
	var lastDelivered pgtype.Int8
	var firstSeen, lastSeen, lastAttempt pgtype.Timestamptz
	err := s.pool.QueryRow(ctx,
		`SELECT greenhouse_id, last_delivered_revision, delivery_status, drift,
		        drift_first_seen, drift_last_seen, last_attempt_at, fail_count
		 FROM reconciliation_state WHERE greenhouse_id=$1`, greenhouseID).
		Scan(&recon.GreenhouseID, &lastDelivered, &recon.DeliveryStatus, &recon.Drift,
			&firstSeen, &lastSeen, &lastAttempt, &recon.FailCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReconState{}, false, nil
	}
	if err != nil {
		return ReconState{}, false, err
	}
	if lastDelivered.Valid {
		recon.LastDeliveredRevision = &lastDelivered.Int64
	}
	recon.DriftFirstSeen = timePtr(firstSeen)
	recon.DriftLastSeen = timePtr(lastSeen)
	recon.LastAttemptAt = timePtr(lastAttempt)
	return recon, true, nil
}

// UpsertReconState writes a greenhouse's reconciliation bookkeeping. Pointer fields encode
// as SQL NULL when nil.
func (s *Store) UpsertReconState(ctx context.Context, recon ReconState) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO reconciliation_state
		   (greenhouse_id, last_delivered_revision, delivery_status, drift,
		    drift_first_seen, drift_last_seen, last_attempt_at, fail_count)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 ON CONFLICT (greenhouse_id) DO UPDATE SET
		    last_delivered_revision=EXCLUDED.last_delivered_revision,
		    delivery_status=EXCLUDED.delivery_status,
		    drift=EXCLUDED.drift,
		    drift_first_seen=EXCLUDED.drift_first_seen,
		    drift_last_seen=EXCLUDED.drift_last_seen,
		    last_attempt_at=EXCLUDED.last_attempt_at,
		    fail_count=EXCLUDED.fail_count`,
		recon.GreenhouseID, recon.LastDeliveredRevision, recon.DeliveryStatus, recon.Drift,
		recon.DriftFirstSeen, recon.DriftLastSeen, recon.LastAttemptAt, recon.FailCount)
	return err
}

// ListDrift returns the set of greenhouse ids currently flagged as drifting — the fleet view
// overlays this onto the registry rows in one query rather than one per card.
func (s *Store) ListDrift(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT greenhouse_id FROM reconciliation_state WHERE drift = TRUE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	drift := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		drift[id] = true
	}
	return drift, rows.Err()
}

// EnsureProvenancePrune registers (idempotently) the TimescaleDB background job that prunes
// superseded provenance revisions older than windowDays, keeping the latest per greenhouse
// (platform data model §2). It shares retention's job scheduler — no new infrastructure.
func (s *Store) EnsureProvenancePrune(ctx context.Context, windowDays int) error {
	if _, err := s.pool.Exec(ctx,
		`SELECT delete_job(job_id) FROM timescaledb_information.jobs
		 WHERE proc_name='prune_setpoint_revisions'`); err != nil {
		return fmt.Errorf("clear prune job: %w", err)
	}
	config := fmt.Sprintf(`{"window_days": %d}`, windowDays)
	if _, err := s.pool.Exec(ctx,
		`SELECT add_job('prune_setpoint_revisions', INTERVAL '1 day', config => $1::jsonb)`, config); err != nil {
		return fmt.Errorf("add prune job: %w", err)
	}
	return nil
}

func scanRevision(rows pgx.Rows) (domain.SetpointRevision, error) {
	var revision domain.SetpointRevision
	var source string
	var setpoints []byte
	if err := rows.Scan(&revision.GreenhouseID, &revision.Revision, &source,
		&revision.Actor, &revision.Reason, &setpoints, &revision.CreatedAt); err != nil {
		return domain.SetpointRevision{}, err
	}
	revision.Source = domain.SetpointSource(source)
	if err := json.Unmarshal(setpoints, &revision.Setpoints); err != nil {
		return domain.SetpointRevision{}, fmt.Errorf("unmarshal setpoints: %w", err)
	}
	return revision, nil
}

func timePtr(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid {
		return nil
	}
	value := ts.Time
	return &value
}
