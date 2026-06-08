# Contracts

Shared message and data contracts — the single source of truth that all three phases conform to.

- `mqtt/` — MQTT topic map and message payload schemas (JSON Schema / AsyncAPI).

Phase 1 (controller) publishes telemetry to these schemas; Phase 2 (platform) ingests them; Phase 3
(optimizer) reads that history. **MQTT carries telemetry only** (sensor readings, actuator state,
fault events, system state) — it is not a command channel. Refined setpoints flow Phase 3 → Phase 2
→ Phase 1 over **REST**, with Phase 2 as the single setpoint authority
([RFC-005](../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).

The conventions these schemas follow — topic taxonomy, the `greenhouse_id` / `zone_id` identity
scheme, the payload envelope, and the JSON Schema format + versioning rule — are defined in
[RFC-007](../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
Changes here should be versioned and accompanied by an ADR in `docs/decisions/`.
