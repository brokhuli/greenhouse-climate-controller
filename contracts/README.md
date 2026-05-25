# Contracts

Shared message and data contracts — the single source of truth that all three phases conform to.

- `mqtt/` — MQTT topic map and message payload schemas (JSON Schema / AsyncAPI).

Phase 1 (controller) publishes to these schemas; Phase 2 (platform) ingests them; Phase 3
(optimizer) reads history and publishes actuator plans against them. Changes here should be
versioned and accompanied by an ADR in `docs/decisions/`.
