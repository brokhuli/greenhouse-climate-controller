-- Time-series telemetry: high-volume, append-only (platform data model §1, 2a slice).
-- These are plain tables here; the store converts them to TimescaleDB hypertables and
-- applies the (env-tunable) retention policy at startup, after migrations
-- (store.EnsureTimescale). Keeping the TimescaleDB-specific calls out of the migration
-- keeps the schema portable and the retention horizon driven by config, not a literal.

-- Per-metric sensor samples. zone_id is null for greenhouse-scoped metrics and set for
-- zone-scoped soil_moisture (mqtt sensor-reading contract).
CREATE TABLE sensor_readings (
    ts            TIMESTAMPTZ      NOT NULL,
    greenhouse_id TEXT             NOT NULL,
    zone_id       TEXT,
    metric        TEXT             NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    unit          TEXT             NOT NULL
);
CREATE INDEX sensor_readings_lookup ON sensor_readings (greenhouse_id, metric, ts DESC);

-- Commanded vs observed actuator positions over time (mqtt actuator-state contract,
-- flattened to a 0–100 position). observed is null when the readback is unavailable.
CREATE TABLE actuator_states (
    ts            TIMESTAMPTZ      NOT NULL,
    greenhouse_id TEXT             NOT NULL,
    zone_id       TEXT,
    actuator      TEXT             NOT NULL,
    commanded     DOUBLE PRECISION NOT NULL,
    observed      DOUBLE PRECISION
);
CREATE INDEX actuator_states_lookup ON actuator_states (greenhouse_id, actuator, ts DESC);

-- Activity-feed events: faults, interlock activations, setpoint edits. severity is the
-- platform's dashboard grading (info/warning/critical), distinct from the controller's
-- warning/alarm fault severity.
CREATE TABLE events (
    ts            TIMESTAMPTZ NOT NULL,
    greenhouse_id TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    severity      TEXT        NOT NULL,
    message       TEXT        NOT NULL,
    source        TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX events_lookup ON events (greenhouse_id, ts DESC);
