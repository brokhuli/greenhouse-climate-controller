# Contracts

Shared message and data contracts — the single source of truth that all three phases conform to.

- `controller-platform-telemetry-mqtt/` — MQTT topic map and message payload schemas (JSON Schema, Draft 2020-12). See
  [`controller-platform-telemetry-mqtt/README.md`](./controller-platform-telemetry-mqtt/README.md) for the topic map, envelope, units, and versioning rule.
- `platform-controller-control-rest/` — the Phase 1 controller's REST configuration and control API (OpenAPI 3.1,
  which uses the same JSON Schema 2020-12 dialect): setpoint/threshold updates, zone status,
  manual-override management, and system health. Greenhouse-scoped paths, unauthenticated on the
  trusted Docker network ([RFC-009](../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
  See [`platform-controller-control-rest/README.md`](./platform-controller-control-rest/README.md). This is the **only** write path
  into the controller — the REST leg of the setpoint chain below.
- `platform-dashboard-rest/` — the Phase 2 platform's operator/fleet REST API (OpenAPI 3.1, same JSON Schema
  2020-12 dialect): the request/response surface the React SPA and operator tooling consume — fleet
  registry, per-greenhouse detail, ad-hoc setpoint edits, and telemetry range queries (slice 2a),
  plus crop-profile CRUD and assignments (slice 2b). `/api`-prefixed, greenhouse-scoped paths; 2a is
  unauthenticated on the trusted Docker network and 2b adds Keycloak OIDC bearer auth
  ([RFC-009](../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
  See [`platform-dashboard-rest/README.md`](./platform-dashboard-rest/README.md). The live-push **WebSocket** fan-out is
  a separate contract — [`platform-dashboard-live-ws/`](./platform-dashboard-live-ws/README.md), below.
- `platform-dashboard-live-ws/` — the Phase 2 platform's live-push **WebSocket** fan-out (JSON Schema, Draft 2020-12):
  the frames the React SPA receives over a single socket — telemetry, status changes, drift, and
  activity events (slice 2a; drift in 2b). **Platform → SPA push only**; each frame carries the
  RFC-007 envelope and is discriminated by `type`, validated with Ajv like the MQTT schemas. See
  [`platform-dashboard-live-ws/README.md`](./platform-dashboard-live-ws/README.md).
- `optimizer-platform-setpoints-rest/` — the Phase 2 platform's **single-authority setpoint write path** (OpenAPI 3.1,
  same JSON Schema 2020-12 dialect): the one endpoint the optimizer (Phase 3) and Phase 4 planner use
  to submit refined climate targets — `POST /api/greenhouses/{id}/setpoints`, validated against
  crop-safe bounds and recorded with `source = optimizer` provenance
  ([RFC-005](../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
  Config-gated service auth ([RFC-011](../docs/decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)).
  See [`optimizer-platform-setpoints-rest/README.md`](./optimizer-platform-setpoints-rest/README.md). The operator's ad-hoc `PATCH` on the
  same path is a different contract, in `platform-dashboard-rest/` above.
- `platform-optimizer-planning-rest/` — the Phase 3 **telemetry read path** (OpenAPI 3.1, same JSON Schema 2020-12
  dialect): the read counterpart to `optimizer-platform-setpoints-rest/`. One consolidated
  `GET /api/greenhouses/{id}/planning-context` returns the optimizer's planning context — current
  setpoints, `(min, mean, max)` telemetry summaries, actuator states, and data-quality/freshness
  signals — in one bounded read. Per the revised
  [RFC-008](../docs/decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) the platform
  may back it with internal SQL views / continuous aggregates, but those are implementation details,
  not the contract; unauthenticated on the trusted Docker network. See
  [`platform-optimizer-planning-rest/README.md`](./platform-optimizer-planning-rest/README.md).
- `optimizer-internal-plan-schema/` — the Phase 3 optimizer's **internal plan contract** (JSON Schema, Draft 2020-12):
  the structured plan the LLM planner emits and the record the service wraps around it — `OptimizerPlan`
  (proposed by the model) plus a `PlanRecord` envelope (provenance + the constraint/confidence gate
  outcome). Consumed by the constraint engine and applier *inside* the optimizer, so it is **not** a
  cross-service wire boundary — the only downward wire stays the `optimizer-platform-setpoints-rest/` setpoint path.
  Governed by [RFC-004](../docs/decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface).
  See [`optimizer-internal-plan-schema/README.md`](./optimizer-internal-plan-schema/README.md).

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
