-- Provenance trace id for optimizer setpoint writes (RFC-005, P3-OBS-1). Nullable: only
-- `source = optimizer` revisions carry one; profile resolutions and operator edits leave it NULL.
ALTER TABLE setpoint_revisions ADD COLUMN optimizer_run_id TEXT;
