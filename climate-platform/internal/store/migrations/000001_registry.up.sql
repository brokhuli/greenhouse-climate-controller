-- Registry: low-volume relational configuration (platform data model §1, 2a slice).
-- The TimescaleDB extension is enabled here so the telemetry hypertables in the next
-- migration can be created. The timescale/timescaledb image preloads the library; this
-- guarantees the extension exists in the platform's database.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- One row per greenhouse: identity (the RFC-007 slug, reused everywhere), display name,
-- and the crop label (null when unassigned — the controller is crop-agnostic).
CREATE TABLE greenhouses (
    id           TEXT PRIMARY KEY,
    display_name TEXT        NOT NULL,
    crop         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How the platform reaches a greenhouse's controller. One-to-one with greenhouses;
-- dropped with the greenhouse on retire. bearer_token is the optional per-controller
-- pre-shared token (RFC-011); null when the controller is unauthenticated.
CREATE TABLE controller_endpoints (
    greenhouse_id   TEXT PRIMARY KEY REFERENCES greenhouses(id) ON DELETE CASCADE,
    rest_base_url   TEXT NOT NULL,
    mqtt_topic_root TEXT NOT NULL,
    bearer_token    TEXT
);
