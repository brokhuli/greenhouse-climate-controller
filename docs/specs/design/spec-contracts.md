# System Contract Catalog (Spec)

The index of every **cross-component contract** in the system — the shared message and data
agreements that let the controller (Phase 1), the platform (Phase 2), the optimizer (Phase 3), and
the Phase 4 extensions interoperate. Each phase spec defers its wire formats to
[`contracts/`](../../../contracts/), "the single source of truth all phases conform to"; this catalog
is the map of *what* contracts exist, who produces and consumes each, and in what format. For the
components on either side of these boundaries, see [`spec-controller-overview.md`](./controller/spec-controller-overview.md),
[`spec-platform-overview.md`](./platform/spec-platform-overview.md), [`spec-climate-optimizer.md`](./spec-climate-optimizer.md),
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
| 2 | Controller REST API | Controller → platform | OpenAPI 3.1 | 1 | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [RFC-009](../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) |
| 3 | Phase 2 Setpoint API | Optimizer (+ Phase 4) → platform | REST (OpenAPI-style) | 2b / 3 | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| 4 | Phase 2 operator/fleet REST API | SPA / operator → platform | REST (OpenAPI-style) | 2a (telemetry/registration/edits) / 2b (profiles/assignments) | [P2 API surface](./platform/spec-platform-api-surface.md) |
| 5 | Phase 2 WebSocket fan-out | Platform → SPA | WebSocket message schema | 2a | [P2 API surface](./platform/spec-platform-api-surface.md) |
| 6 | Optimizer plan schema | Planner → constraint engine / applier | Structured schema (JSON Schema) | 3 | [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| 7 | Telemetry read-surface views | Platform → optimizer | Versioned SQL views | 2b / 3 | [RFC-008](../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |

### 2.1 MQTT telemetry schemas

| | |
|---|---|
| **Purpose** | Sensor readings, actuator state, fault events, and consolidated system state published by each controller and ingested by the platform; the optimizer reads the resulting history. Telemetry-only — never a command channel. |
| **Parties / direction** | Controller → platform, optimizer (publish / subscribe) |
| **Format** | JSON Schema (Draft 2020-12), one file per message type; hierarchical `gh/{greenhouse_id}/...` topic taxonomy; common payload envelope |
| **Phase introduced** | Phase 1 |
| **Governing decision** | [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format) (taxonomy, envelope, format), [RFC-001](../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection) (broker, QoS, retained) |
| **Location** | [`contracts/mqtt/`](../../../contracts/mqtt/) |
| **Status** | Authored — envelope + per-message schemas exist under [`contracts/mqtt/`](../../../contracts/mqtt/) |

### 2.2 Controller REST API

| | |
|---|---|
| **Purpose** | The controller's setpoint/threshold CRUD, zone status, manual-override management, and health surface — the only inbound write path into a controller. |
| **Parties / direction** | Controller (producer) → platform (the sole consumer). The Phase 2 frontend reaches the controller **through** the Go API, not directly; there is no controller-local frontend. |
| **Format** | OpenAPI 3.1 (uses the JSON Schema 2020-12 dialect); greenhouse-scoped paths; 422 names the violated bound |
| **Phase introduced** | Phase 1 (consumed by the platform from Phase 2 — the ad-hoc setpoint relay in 2a, the full resolution path in 2b) |
| **Governing decision** | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) (controller is setpoint-only), [RFC-009](../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) (unauthenticated — Docker network is the trust boundary), [P1 §11](./controller/spec-controller-interfaces.md) |
| **Location** | [`contracts/controller-rest/`](../../../contracts/controller-rest/) |
| **Status** | Authored — `openapi.json` + README + example fixtures exist under [`contracts/controller-rest/`](../../../contracts/controller-rest/) |

### 2.3 Phase 2 Setpoint API

| | |
|---|---|
| **Purpose** | The single setpoint-authority endpoint (`POST /greenhouses/{id}/setpoints`): the optimizer submits refined targets; the platform validates against crop-safe bounds, records provenance, and delivers to the controller. |
| **Parties / direction** | Optimizer (and Phase 4 planner) → platform (write) |
| **Format** | REST request/response — accept (202) / reject with violated bound (422) |
| **Phase introduced** | Phase 2b (the bounds-enforcing endpoint); first cross-phase consumer in Phase 3 |
| **Governing decision** | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| **Location** | To be created |
| **Status** | To author |

### 2.4 Phase 2 operator/fleet REST API

| | |
|---|---|
| **Purpose** | The operator-facing surface: greenhouse registry, historical telemetry range queries, analytics, and ad-hoc setpoint edits (**2a**); crop-profile CRUD and assignments (**2b**). |
| **Parties / direction** | SPA / operator tooling → platform |
| **Format** | REST request/response (OpenAPI-style description recommended) |
| **Phase introduced** | Phase 2 — registration/telemetry/edits in 2a, profiles/assignments in 2b |
| **Governing decision** | [P2 API surface](./platform/spec-platform-api-surface.md) |
| **Location** | To be created |
| **Status** | To author |

### 2.5 Phase 2 WebSocket fan-out

| | |
|---|---|
| **Purpose** | Live, fleet-wide push of telemetry, status changes, drift, and events to the dashboard. |
| **Parties / direction** | Platform → SPA |
| **Format** | WebSocket message schema (shares the RFC-007 identity / timestamp envelope) |
| **Phase introduced** | Phase 2a |
| **Governing decision** | [P2 API surface](./platform/spec-platform-api-surface.md) |
| **Location** | To be created |
| **Status** | To author |

### 2.6 Optimizer plan schema

| | |
|---|---|
| **Purpose** | The structured plan the LLM planner emits (refined setpoints + reasoning/audit trace), consumed deterministically by the constraint engine and plan applier. Phase 4 extends it to be combustion-aware (device-selection preferences). |
| **Parties / direction** | Planner → constraint engine / applier (internal to the optimizer) |
| **Format** | Structured schema (JSON Schema) |
| **Phase introduced** | Phase 3 (extended in Phase 4) |
| **Governing decision** | [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| **Location** | [`contracts/`](../../../contracts/), to be created |
| **Status** | To author |

### 2.7 Telemetry read-surface views

| | |
|---|---|
| **Purpose** | The optimizer's read path into the platform's history: a small set of named, versioned views (e.g. `optimizer_sensor_readings`, `optimizer_actuator_states`, `optimizer_current_setpoints`) the optimizer reads via a read-only role — not the raw hypertables. |
| **Parties / direction** | Platform (owns the views) → optimizer (`optimizer_ro` role, read) |
| **Format** | Versioned SQL views (TimescaleDB / PostgreSQL); breaking change is an ADR event |
| **Phase introduced** | Phase 2 (the views) / Phase 3 (the consumer) |
| **Governing decision** | [RFC-008](../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |
| **Location** | Platform migrations; to be created |
| **Status** | To author |

---

## 3. Not System Contracts

Boundaries that look like contracts but deliberately are **not** part of `contracts/`:

| Item | Why it is excluded |
|---|---|
| External weather feed (Phase 4) | An external provider's payload, **normalized at ingestion** into the optimizer's internal trajectory ([spec-phase4.md §9](./spec-phase4.md#9-interfaces--integration)). The provider format is not a system contract; only the normalized internal form crosses optimizer boundaries. |
| MQTT as a command / setpoint channel | Explicitly rejected: MQTT is **telemetry-only**. Setpoints reach the controller over REST with the platform as single authority ([RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)). There are no command topics to contract. |
