# Platform — Interfaces & API Surface

> **Purpose:** Define the platform's interface boundaries on both sides. First, the
> cross-component interfaces the platform sits across — MQTT up from the
> controllers, controller REST down to them, and WebSockets out to the frontend.
> Then, the **responsibilities** of the Go API's own outward surface — REST for
> request/response, including the Phase 3 optimizer read/write API, and WebSockets for live push — and which delivery slice each lands
> in. This file lists *which interface does what* and *what the surface does*, not its
> wire shapes: topic maps, REST shapes, and message schemas are owned by
> [`contracts/`](../../../../contracts/) and the
> [controller interfaces](../controller/08-spec-controller-interfaces.md) spec, catalogued
> in [`spec-contracts.md`](../spec-contracts.md), under the conventions in
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 1. The core interfaces

| Interface | Direction | Role |
|---|---|---|
| **MQTT** | Controller → platform | Telemetry ingest: readings, actuator states, fault/state events |
| **Controller REST** | Platform → controller | Setpoint resolution (profile apply/reconcile) + ad-hoc setpoint edits |
| **WebSockets** | Platform → frontend | Live fan-out of telemetry, status, drift, events |
| **Platform REST** | Platform → optimizer | Phase 3 planning-context/history reads; optimizer setpoint submissions back into the platform authority |

Each maps to one of the platform's [data flows](./02-spec-platform-architecture.md#3-three-data-flows):
MQTT is the **up** flow ([ingestion](./04-spec-platform-ingestion.md)), controller REST is
the **down** flow ([crop profiles](./05-spec-platform-crop-profiles.md)), and WebSockets is
the **dashboard** flow. The platform's own served API — the REST surface plus that
WebSocket fan-out — is detailed in [§3 below](#3-api-surface-inventory).

---

## 2. Telemetry-only over MQTT, all control over REST

Consistent with
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
MQTT is **telemetry-only** (controller → platform); there are no command topics. All
setpoint writes go over the controller REST API
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
This keeps the two directions on separate transports with separate trust and delivery
semantics, and mirrors the controller's own
[headless contract](../controller/08-spec-controller-interfaces.md#1-the-headless-principle).

When Phase 3 lands, the optimizer does **not** add another interface to the
controller: it reads planning context through the platform REST API, then submits refined targets through the platform's own setpoint write path
([crop profiles §4](./05-spec-platform-crop-profiles.md#4-boundary-with-phase-3--single-setpoint-authority)),
and the platform remains the sole party speaking the controller REST API.

---

## 3. API surface inventory

The platform's outward-facing API is the [hub](./02-spec-platform-architecture.md#2-the-go-api-is-the-hub);
every surface here is a facet of one of its responsibilities. Concrete routes,
payloads, and status codes are deferred to [`contracts/`](../../../../contracts/) and
catalogued in [`spec-contracts.md`](../spec-contracts.md); this lists *what the surface
does*, not its wire shapes.

| Surface | Role | Slice |
|---|---|---|
| **REST — greenhouses** | Register/retire greenhouses; read fleet + per-greenhouse status. The per-greenhouse **detail** snapshot merges the controller's live `/zones` into a read-only `zone_status` alongside the current setpoints bundle | 2a |
| **REST — telemetry** | Range queries over historical readings/actuator states/events | 2a |
| **REST — analytics** | Aggregations and derived series for dashboards — including the fleet-wide **sparklines** read (one metric's recent history for every greenhouse, batched for the overview) | 2a |
| **REST — setpoint edits** | Ad-hoc setpoint edits, relayed to controllers (sticky intended state once reconciliation exists) | 2a |
| **REST — simulation time-scale** *(sim-only)* | Read/set a controller's simulated-clock **speed**, per-greenhouse and fleet-wide, relayed to the controller's sim-only [`/sim/time-scale`](../controller/08-spec-controller-interfaces.md#simulation-control-simulated-hal-only). The fleet form fans out as N independent per-controller writes (no shared clock). An explicit, narrow exception to setpoint-only control — a diagnostic, not a setpoint; rejected (404) for a real-hardware controller. The current speed is also surfaced on the greenhouse status and the WebSocket `status` frame | 2a |
| **WebSockets** | Live fan-out of telemetry, status changes (incl. sim time-scale), drift, and events to the dashboard | 2a |
| **REST — crop profiles** | CRUD on the profile library and their stage-aware target bundles | 2b |
| **REST — assignments** | Assign a profile/stage to a greenhouse; trigger apply/reconcile | 2b |
| **REST — setpoints (`POST`)** | Single-authority setpoint submission at `POST /api/greenhouses/{id}/setpoints` (the optimizer's RFC-005 write path; `POST /setpoints` for short) + provenance | 2b |
| **REST — optimizer telemetry read API** | Phase 3 read path: bounded planning-context/history reads for one greenhouse, including telemetry, actuator state, current setpoints, and data-quality/freshness signals. Implemented by the platform over internal SQL views or continuous aggregates so the optimizer consumes REST rather than the database schema. | 2b / 3 |
| **REST — optimizer operator API** *(proxy/aggregate)* | Phase 3 operator surface for the dashboard: the Go API **proxies** the optimizer's own [Service API](../optimizer/10-spec-optimizer-interfaces.md#service-api-endpoints) operator endpoints (latest plan, open escalations, model + enable state — **service-wide and per-greenhouse**, on-demand cycle, escalation resolve, model/enable mutations) and its `fleet` rollup (per-greenhouse latest outcome **and `enabled` flag** + site aggregates), **derives** the internal `GET /health` into a versioned frontend `GET /api/optimizer/status` (service-health badge — status/degraded-reason, last-successful-cycle vs cadence, read-only reason; `unavailable` synthesized when the optimizer is unreachable), and **composes** the setpoint-diff the plan panel renders (plan-proposed `immediate_setpoints` vs the greenhouse's current setpoints vs its crop-safe bounds — both platform-owned). Re-exposed to the SPA under the versioned [`contracts/platform-dashboard-rest/`](../../../../contracts/platform-dashboard-rest/) surface; the SPA reaches the optimizer **only** here, never a second origin. | 3 |

Each surface maps to a concern documented elsewhere: telemetry queries read what
[ingestion](./04-spec-platform-ingestion.md) stored; profiles/assignments/setpoints drive
[crop profiles & reconciliation](./05-spec-platform-crop-profiles.md); the WebSocket
channel is consumed by the [dashboard](./06-spec-platform-dashboard.md); the optimizer telemetry read
API is the Phase 3 REST wrapper over the platform-owned read model; the optimizer operator API is the
Phase 3 proxy/aggregate over the optimizer's own [Service API](../optimizer/10-spec-optimizer-interfaces.md#service-api-endpoints)
so the dashboard reaches the optimizer through the one hub.

---

## 4. Request/response vs live push

- **REST** is the request/response surface: reads (fleet, telemetry ranges, analytics)
  and writes (registration, setpoint edits, profiles, assignments).
- **WebSockets** is the live-push surface: a single fan-out of telemetry, status
  changes, drift, and events so the dashboard reflects the fleet in real time without
  polling. The proxy passes the WebSocket upgrade through
  ([architecture §4](./02-spec-platform-architecture.md#4-reverse-proxy--the-edge)).

---

## 5. Authorization

Write endpoints require the **operator** role once auth lands
([security](./07-spec-platform-security.md), **2b**); in the unauthenticated 2a MVP the
setpoint-edit and registration endpoints are open on the trusted local network. The per-surface
capability split (viewer reads; operator reads + writes) is owned by
[security](./07-spec-platform-security.md#4-capability-matrix).

The **`POST /setpoints`** surface additionally accepts a **service** actor — the optimizer — when the
config-gated service-auth mode is enabled (`SERVICE_AUTH_MODE=oidc`,
[RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
superseding [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)):
the optimizer presents a Keycloak client-credentials token carrying the narrow `setpoints:write` role
rather than a human operator token ([security §3](./07-spec-platform-security.md#two-actor-types-human-and-service)).
By default (`trusted_network`) the path is open on the local network, as in 2a. No other surface is
reachable by a service actor.

The **optimizer operator API** (the proxy/aggregate surface above) is gated on **two** planes. *Outward*
the SPA calls it like any other Go API surface: its **reads** are viewer-open and its **mutations**
(resolve escalation, trigger cycle, switch model, enable/disable — service-wide or per-greenhouse) require
the **operator** role once auth lands (2b), exactly as the setpoint-edit surface. *Inward* the Go-API → optimizer FastAPI call is a
service-to-service hop: untokened on the `trusted_network` default (single-host local), and under
`SERVICE_AUTH_MODE=oidc` the Go API presents a Keycloak service credential — mirroring the RFC-011 pattern
the optimizer already uses on its own [Phase 2 write path](../optimizer/10-spec-optimizer-interfaces.md#authenticating-the-phase-2-write-path).
The optimizer re-checks the operator role on its own mutating endpoints regardless
([optimizer interfaces](../optimizer/10-spec-optimizer-interfaces.md#authenticating-the-model-change-endpoint)).

---

## 6. Contract ownership

The MQTT topic map and the controller REST shapes the platform depends on are owned by
[`contracts/`](../../../../contracts/) and the
[controller interfaces](../controller/08-spec-controller-interfaces.md) spec; this file
**consumes** those contracts rather than defining them. Likewise the concrete routes,
payloads, and status codes of the platform's own served API are deferred to
`contracts/`. The full catalog of system contracts — every cross-component boundary,
including the platform's own API surface — is [`spec-contracts.md`](../spec-contracts.md).

---

## 7. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| MQTT-up flow behavior | frames | [`04-spec-platform-ingestion.md`](./04-spec-platform-ingestion.md) |
| Controller-REST-down flow behavior | frames | [`05-spec-platform-crop-profiles.md`](./05-spec-platform-crop-profiles.md) |
| What the telemetry queries read | reads | [`04-spec-platform-ingestion.md`](./04-spec-platform-ingestion.md), [`03-spec-platform-data-model.md`](./03-spec-platform-data-model.md) |
| What profiles/assignments/setpoints drive | drives | [`05-spec-platform-crop-profiles.md`](./05-spec-platform-crop-profiles.md) |
| Who consumes the WebSocket stream | served to | [`06-spec-platform-dashboard.md`](./06-spec-platform-dashboard.md), [frontend data model](../frontend/05-spec-frontend-data-model.md) |
| The controller surfaces being integrated | integrates | [controller interfaces](../controller/08-spec-controller-interfaces.md) |
| Which role may call what | gated by | [`07-spec-platform-security.md`](./07-spec-platform-security.md) |
| Wire formats (topics, REST shapes, schemas, status codes) | defers to | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md) |
| Topic/identity/envelope conventions; setpoint-delivery chain | defers to | [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
