-- Crop profiles, assignment, and the intended-state / provenance ledger (platform data
-- model §1, 2b slice). These are low-volume relational tables: profiles are a small
-- hand-edited library, one assignment per greenhouse, and the revision ledger grows one
-- row per intended-state change (edit-paced, not sample-paced). Target bundles are stored
-- as JSONB because they mirror the controller's setpoint schema whole and are read/written
-- as a unit — normalizing them into columns buys nothing and would couple the schema to
-- the contract's exact field list.

-- The crop-profile library. stages is a JSON array of {stage, targets:Setpoints}
-- (contracts/frontend-rest CropProfile). id is the operator-chosen RFC-007 slug.
CREATE TABLE crop_profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT        NOT NULL,
    crop       TEXT        NOT NULL,
    stages     JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active assignment per greenhouse: a profile + the current growth stage. Dropped
-- with the greenhouse on retire; a profile still referenced here cannot be deleted
-- (ON DELETE RESTRICT) so an assignment never dangles.
CREATE TABLE profile_assignments (
    greenhouse_id TEXT PRIMARY KEY REFERENCES greenhouses(id) ON DELETE CASCADE,
    profile_id    TEXT        NOT NULL REFERENCES crop_profiles(id) ON DELETE RESTRICT,
    stage         TEXT        NOT NULL,
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The append-only intended-state / provenance ledger. The latest revision per greenhouse
-- is the current intended state reconciliation reads; superseded revisions are audit
-- history, pruned past a window (below). revision is monotonic per greenhouse; source is
-- the provenance (profile | operator_edit | optimizer, RFC-005).
CREATE TABLE setpoint_revisions (
    greenhouse_id TEXT        NOT NULL REFERENCES greenhouses(id) ON DELETE CASCADE,
    revision      BIGINT      NOT NULL,
    source        TEXT        NOT NULL,
    actor         TEXT        NOT NULL DEFAULT '',
    reason        TEXT        NOT NULL DEFAULT '',
    setpoints     JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (greenhouse_id, revision)
);
CREATE INDEX setpoint_revisions_current ON setpoint_revisions (greenhouse_id, revision DESC);

-- Per-greenhouse reconciliation bookkeeping: which revision last reached the controller,
-- its delivery status, and the current drift verdict (controller-reported setpoints vs
-- intended). fail_count backs the rate-limited auto-correction (crop-profiles §3).
CREATE TABLE reconciliation_state (
    greenhouse_id           TEXT PRIMARY KEY REFERENCES greenhouses(id) ON DELETE CASCADE,
    last_delivered_revision BIGINT,
    delivery_status         TEXT        NOT NULL DEFAULT 'pending',
    drift                   BOOLEAN     NOT NULL DEFAULT FALSE,
    drift_first_seen        TIMESTAMPTZ,
    drift_last_seen         TIMESTAMPTZ,
    last_attempt_at         TIMESTAMPTZ,
    fail_count              INTEGER     NOT NULL DEFAULT 0
);

-- Prune of superseded provenance rows. The ledger is append-only but is bounded not by
-- the telemetry retention policy (it is relational, not a hypertable) — instead by this
-- scheduled DELETE: per greenhouse the latest revision is kept indefinitely (live
-- intended state), while superseded revisions older than window_days are dropped (platform
-- data model §2). It is defined as a TimescaleDB user-defined action so it shares the same
-- background-job scheduler as retention; the job is registered from config in
-- store.EnsureProvenancePrune.
CREATE PROCEDURE prune_setpoint_revisions(job_id INTEGER, config JSONB)
LANGUAGE plpgsql AS $$
DECLARE
    window_days INTEGER := COALESCE((config->>'window_days')::INTEGER, 30);
BEGIN
    DELETE FROM setpoint_revisions r
    WHERE r.created_at < now() - make_interval(days => window_days)
      AND r.revision < (SELECT max(cur.revision) FROM setpoint_revisions cur
                        WHERE cur.greenhouse_id = r.greenhouse_id);
END;
$$;
