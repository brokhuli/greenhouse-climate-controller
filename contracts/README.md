# Contracts

Shared message and data contracts — the single source of truth that all three phases conform to.

- `mqtt/` — MQTT topic map and message payload schemas (JSON Schema, Draft 2020-12). See
  [`mqtt/README.md`](./mqtt/README.md) for the topic map, envelope, units, and versioning rule.
- `controller-rest/` — the Phase 1 controller's REST configuration and control API (OpenAPI 3.1,
  which uses the same JSON Schema 2020-12 dialect): setpoint/threshold updates, zone status,
  manual-override management, and system health. Greenhouse-scoped paths, unauthenticated on the
  trusted Docker network ([RFC-009](../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
  See [`controller-rest/README.md`](./controller-rest/README.md). This is the **only** write path
  into the controller — the REST leg of the setpoint chain below.
- `frontend-rest/` — the Phase 2 platform's operator/fleet REST API (OpenAPI 3.1, same JSON Schema
  2020-12 dialect): the request/response surface the React SPA and operator tooling consume — fleet
  registry, per-greenhouse detail, ad-hoc setpoint edits, and telemetry range queries (slice 2a),
  plus crop-profile CRUD and assignments (slice 2b). `/api`-prefixed, greenhouse-scoped paths; 2a is
  unauthenticated on the trusted Docker network and 2b adds Keycloak OIDC bearer auth
  ([RFC-009](../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
  See [`frontend-rest/README.md`](./frontend-rest/README.md). The live-push **WebSocket** fan-out is
  a separate, still-to-author contract.

Phase 1 (controller) publishes telemetry to these schemas; Phase 2 (platform) ingests them; Phase 3
(optimizer) reads that history. **MQTT carries telemetry only** (sensor readings, actuator state,
fault events, system state) — it is not a command channel. Refined setpoints flow Phase 3 → Phase 2
→ Phase 1 over **REST**, with Phase 2 as the single setpoint authority
([RFC-005](../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).

The conventions these schemas follow — topic taxonomy, the `greenhouse_id` / `zone_id` identity
scheme, the payload envelope, and the JSON Schema format + versioning rule — are defined in
[RFC-007](../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
Changes here should be versioned and accompanied by an ADR in `docs/decisions/`.

The full list of system contracts — every cross-component boundary, with its purpose, parties, and
format — is catalogued in
[`docs/specs/design/spec-contracts.md`](../docs/specs/design/spec-contracts.md). This README owns the
MQTT schema *contents*; the catalog owns the *index* of which contracts exist.
