# System Contract Catalog (Spec)

The index of every **cross-component contract** in the system — the shared message and data
agreements that let the controller (Phase 1), the platform (Phase 2), the optimizer (Phase 3), and
the Phase 4 extensions interoperate. Each phase spec defers its wire formats to
[`contracts/`](../../../contracts/), "the single source of truth all phases conform to"; this catalog
is the map of *what* contracts exist, who produces and consumes each, and in what format. For the
components on either side of these boundaries, see [`01-spec-controller-overview.md`](./controller/01-spec-controller-overview.md),
[`01-spec-platform-overview.md`](./platform/01-spec-platform-overview.md), [`01-spec-optimizer-overview.md`](./optimizer/01-spec-optimizer-overview.md),
and [`spec-phase4.md`](./spec-phase4.md).

> Scope note: this is a **catalog**, not a schema. It lists each contract and its purpose, parties,
> and format — it does **not** define contract contents. Field-level schemas live in
> [`contracts/`](../../../contracts/) and the governing RFCs, under the conventions (topic taxonomy,
> `greenhouse_id` / `zone_id` identity, payload envelope, JSON Schema format + versioning) fixed by
> [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 1. Overview

A contract exists wherever two independently-built components must agree on a wire or data format.
The system has seven such boundaries, spread across the three core phases and the Phase 4 stretch
goal. They are catalogued here in one place because the contracts are otherwise scattered across
RFC-004/005/007/008/009 and the interface sections of four separate specs, making it hard to see the
full set at a glance.

This document records *which* contracts exist and their shape (purpose, parties, format, phase,
governing decision). It is the authoritative **list**; [`contracts/`](../../../contracts/) remains the
authoritative **content**. Every entry names a producer → consumer boundary; a change to any contract
is versioned and accompanied by an ADR, per [`contracts/README.md`](../../../contracts/README.md).

---

## 2. Contract Catalog

| # | Contract | Producer → Consumer | Format | Phase | Governing decision |
|---|---|---|---|---|---|
| 1 | MQTT telemetry schemas | Controller → platform, optimizer | JSON Schema (Draft 2020-12) | 1 | [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-001](../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection) |
| 2 | Controller REST API | Controller → platform | OpenAPI 3.1 | 1 | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [RFC-011](../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) (supersedes [RFC-009](../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)) |
| 3 | Phase 2 Setpoint API | Optimizer (+ Phase 4) → platform | OpenAPI 3.1 | 2b / 3 | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [RFC-011](../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) |
| 4 | Phase 2 operator/fleet REST API | SPA / operator → platform | OpenAPI 3.1 | 2a (telemetry/registration/edits) / 2b (profiles/assignments) | [P2 API surface](./platform/09-spec-platform-interfaces.md#3-api-surface-inventory) |
| 5 | Phase 2 WebSocket fan-out | Platform → SPA | WebSocket message schema | 2a | [P2 API surface](./platform/09-spec-platform-interfaces.md#3-api-surface-inventory) |
| 6 | Optimizer plan schema | Planner → constraint engine / applier | Structured schema (JSON Schema) | 3 | [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| 7 | Phase 3 telemetry read API | Platform → optimizer | REST (OpenAPI-style), backed by internal SQL views | 2b / 3 | [RFC-008 revision](../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |

### 2.1 MQTT telemetry schemas

| | |
|---|---|
| **Purpose** | Sensor readings, actuator state, fault events, and consolidated system state published by each controller and ingested by the platform; the optimizer reads the resulting history. Telemetry-only — never a command channel. The consolidated system state carries an optional simulation-only `simulation` block (`time_scale`, `tick_index`) on a simulated controller. |
| **Parties / direction** | Controller → platform, optimizer (publish / subscribe) |
| **Format** | JSON Schema (Draft 2020-12), one file per message type; hierarchical `gh/{greenhouse_id}/...` topic taxonomy; common payload envelope |
| **Phase introduced** | Phase 1 |
| **Governing decision** | [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format) (taxonomy, envelope, format), [RFC-001](../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection) (broker, QoS, retained) |
| **Location** | [`contracts/mqtt/`](../../../contracts/mqtt/) |
| **Status** | Authored — envelope + per-message schemas exist under [`contracts/mqtt/`](../../../contracts/mqtt/) |

### 2.2 Controller REST API

| | |
|---|---|
| **Purpose** | The controller's setpoint/threshold CRUD, zone status, manual-override management, and health surface — the only inbound write path into a controller. Plus a simulation-only diagnostic surface: sensor-reading injection and the time-scale (speed) knob (`GET`/`PUT /sim/time-scale`), both 404 on real hardware. |
| **Parties / direction** | Controller (producer) → platform (the sole consumer). The Phase 2 frontend reaches the controller **through** the Go API, not directly; there is no controller-local frontend. |
| **Format** | OpenAPI 3.1 (uses the JSON Schema 2020-12 dialect); greenhouse-scoped paths; 422 names the violated bound |
| **Phase introduced** | Phase 1 (consumed by the platform from Phase 2 — the ad-hoc setpoint relay in 2a, the full resolution path in 2b) |
| **Governing decision** | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) (controller is setpoint-only), [RFC-011](../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) (unauthenticated by default — Docker network is the trust boundary — with an optional per-controller bearer token; supersedes [RFC-009](../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)), [P1 §11](./controller/08-spec-controller-interfaces.md) |
| **Location** | [`contracts/controller-rest/`](../../../contracts/controller-rest/) |
| **Status** | Authored — `openapi.json` + README + example fixtures exist under [`contracts/controller-rest/`](../../../contracts/controller-rest/) |

### 2.3 Phase 2 Setpoint API

| | |
|---|---|
| **Purpose** | The single setpoint-authority endpoint (`POST /greenhouses/{id}/setpoints`): the optimizer submits refined targets; the platform validates against crop-safe bounds, records provenance (`source = optimizer`), and delivers to the controller. Returns the resulting intended state as `202 Accepted`. |
| **Parties / direction** | Optimizer (and Phase 4 planner) → platform (write) |
| **Format** | OpenAPI 3.1 (uses the JSON Schema 2020-12 dialect); `/api`-prefixed, greenhouse-scoped path; accept (202) / reject with violated bound (422). Shares the `Setpoints` / `SetpointsPatch` body shape with the operator/fleet contract's ad-hoc `PATCH` (#2.4), kept as a local copy per the self-contained-contract convention. |
| **Phase introduced** | Phase 2b (the bounds-enforcing endpoint); first cross-phase consumer in Phase 3 |
| **Governing decision** | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) (single authority), [RFC-011](../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) (config-gated `SERVICE_AUTH_MODE` service boundary — untokened by default, `setpoints:write` under `oidc`) |
| **Location** | [`contracts/optimizer-write-rest/`](../../../contracts/optimizer-write-rest/) |
| **Status** | Authored — `openapi.json` + README + example fixtures exist under [`contracts/optimizer-write-rest/`](../../../contracts/optimizer-write-rest/) |

### 2.4 Phase 2 operator/fleet REST API

| | |
|---|---|
| **Purpose** | The operator-facing surface: greenhouse registry, historical telemetry range queries, analytics, and ad-hoc setpoint edits (**2a**); crop-profile CRUD and assignments (**2b**); and the **optimizer operator console** (**3**) — the Go API's proxy/aggregate over the optimizer's own [Service API](./optimizer/10-spec-optimizer-interfaces.md#service-api-endpoints): the `optimizer/*` paths (fleet queue + rollup, per-greenhouse plan + composed setpoint diff, open escalations + resolve, model + enable state and their mutations, on-demand cycles). Includes a simulation-only time-scale relay (per-greenhouse + fleet-wide `/sim/time-scale`) — the one explicit exception to setpoint-only downward control. |
| **Parties / direction** | SPA / operator tooling → platform (the SPA reaches the optimizer **only** here, never a second origin) |
| **Format** | OpenAPI 3.1 (uses the JSON Schema 2020-12 dialect); `/api`-prefixed, greenhouse-scoped paths; 422 names the violated bound |
| **Phase introduced** | Phase 2 — registration/telemetry/edits in 2a, profiles/assignments in 2b; **Phase 3** adds the `optimizer/*` operator-console paths |
| **Governing decision** | [P2 API surface](./platform/09-spec-platform-interfaces.md#3-api-surface-inventory), [ADR 2026-06-17](../../decisions/architecture-design-record.md) |
| **Location** | [`contracts/frontend-rest/`](../../../contracts/frontend-rest/) |
| **Status** | Authored — `openapi.json` + README + example fixtures exist under [`contracts/frontend-rest/`](../../../contracts/frontend-rest/), validated by the contract harness (incl. the Phase 3 `optimizer/*` paths + fixtures) |

### 2.5 Phase 2 WebSocket fan-out

| | |
|---|---|
| **Purpose** | Live, fleet-wide push of telemetry, status changes, drift, and events to the dashboard. The `status` frame carries an optional simulation-only `time_scale` so the dashboard's per-greenhouse speed indicator stays live. |
| **Parties / direction** | Platform → SPA |
| **Format** | WebSocket message schema (JSON Schema, Draft 2020-12); shares the RFC-007 identity / timestamp envelope; one file per frame type, discriminated by `type` |
| **Phase introduced** | Phase 2a |
| **Governing decision** | [P2 API surface](./platform/09-spec-platform-interfaces.md#3-api-surface-inventory), [ADR 2026-06-17](../../decisions/architecture-design-record.md) |
| **Location** | [`contracts/frontend-ws/`](../../../contracts/frontend-ws/) |
| **Status** | Authored — JSON Schema files + README + example fixtures exist under [`contracts/frontend-ws/`](../../../contracts/frontend-ws/) |

### 2.6 Optimizer plan schema

| | |
|---|---|
| **Purpose** | The structured plan the LLM planner emits, in two layers: `OptimizerPlan` (the LLM's refined setpoint trajectory, immediate setpoints, confidence, and reasoning/audit trace) wrapped by `PlanRecord` (the service's provenance + gate-outcome envelope), consumed deterministically by the constraint engine and plan applier. Phase 4 extends it to be combustion-aware (device-selection preferences). Defined in [`05-spec-optimizer-plan-contract.md`](./optimizer/05-spec-optimizer-plan-contract.md). |
| **Parties / direction** | Planner → constraint engine / applier (internal to the optimizer) |
| **Format** | Structured schema (JSON Schema, Draft 2020-12) |
| **Phase introduced** | Phase 3 (extended in Phase 4) |
| **Governing decision** | [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| **Location** | [`contracts/optimizer-plan/`](../../../contracts/optimizer-plan/) |
| **Status** | Authored — schemas + README + example fixtures exist under [`contracts/optimizer-plan/`](../../../contracts/optimizer-plan/), validated by the contract harness |

### 2.7 Phase 3 telemetry read API

| | |
|---|---|
| **Purpose** | The optimizer's read path into the platform's history: REST endpoints that return historical telemetry, actuator states, current setpoints, and data-quality/freshness signals for one greenhouse. The platform may back those handlers with internal SQL views or continuous aggregates, but the optimizer consumes the REST contract rather than connecting to the database. |
| **Parties / direction** | Platform REST API → optimizer (read) |
| **Format** | REST request/response (OpenAPI-style), with stable JSON response schemas. Internal SQL views are platform implementation details; breaking changes to the REST shape are ADR events. |
| **Phase introduced** | Phase 2 (the REST surface and internal views) / Phase 3 (the consumer) |
| **Governing decision** | [RFC-008 revision](../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |
| **Location** | [`contracts/optimizer-read-rest/`](../../../contracts/optimizer-read-rest/) |
| **Status** | Authored — `openapi.json` + README + example fixtures exist under [`contracts/optimizer-read-rest/`](../../../contracts/optimizer-read-rest/). One consolidated `GET /api/greenhouses/{id}/planning-context` returning current setpoints, `(min, mean, max)` telemetry summaries, actuator states, and data-quality/freshness signals. |

---

## 3. Not System Contracts

Boundaries that look like contracts but deliberately are **not** part of `contracts/`:

| Item | Why it is excluded |
|---|---|
| External weather feed (Phase 4) | An external provider's payload, **normalized at ingestion** into the optimizer's internal trajectory ([spec-phase4.md §9](./spec-phase4.md#9-interfaces--integration)). The provider format is not a system contract; only the normalized internal form crosses optimizer boundaries. |
| MQTT as a command / setpoint channel | Explicitly rejected: MQTT is **telemetry-only**. Setpoints reach the controller over REST with the platform as single authority ([RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)). There are no command topics to contract. |
