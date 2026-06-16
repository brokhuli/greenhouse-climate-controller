# Platform — API Surface

> **Purpose:** Enumerate the **responsibilities** of the Go API's outward surface —
> REST for request/response and WebSockets for live push — and which delivery slice
> each lands in. Concrete routes, payloads, and status codes are deferred to
> [`contracts/`](../../../../contracts/) and catalogued in
> [`spec-contracts.md`](../spec-contracts.md); this file lists *what the surface does*,
> not its wire shapes.

The API is the platform's [hub](./spec-platform-architecture.md#2-the-go-api-is-the-hub);
every surface here is a facet of one of its responsibilities.

---

## 1. Surface inventory

| Surface | Role | Slice |
|---|---|---|
| **REST — greenhouses** | Register/retire greenhouses; read fleet + per-greenhouse status | 2a |
| **REST — telemetry** | Range queries over historical readings/actuator states/events | 2a |
| **REST — analytics** | Aggregations and derived series for dashboards | 2a |
| **REST — setpoint edits** | Ad-hoc setpoint edits, relayed to controllers (sticky intended state once reconciliation exists) | 2a |
| **WebSockets** | Live fan-out of telemetry, status changes, drift, and events to the dashboard | 2a |
| **REST — crop profiles** | CRUD on the profile library and their stage-aware target bundles | 2b |
| **REST — assignments** | Assign a profile/stage to a greenhouse; trigger apply/reconcile | 2b |
| **REST — setpoints (`POST`)** | Single-authority setpoint submission (the optimizer's RFC-005 write path) + provenance | 2b |

Each surface maps to a concern documented elsewhere: telemetry queries read what
[ingestion](./spec-platform-ingestion.md) stored; profiles/assignments/setpoints drive
[crop profiles & reconciliation](./spec-platform-crop-profiles.md); the WebSocket
channel is consumed by the [dashboard](./spec-platform-dashboard.md).

---

## 2. Request/response vs live push

- **REST** is the request/response surface: reads (fleet, telemetry ranges, analytics)
  and writes (registration, setpoint edits, profiles, assignments).
- **WebSockets** is the live-push surface: a single fan-out of telemetry, status
  changes, drift, and events so the dashboard reflects the fleet in real time without
  polling. The proxy passes the WebSocket upgrade through
  ([architecture §4](./spec-platform-architecture.md#4-reverse-proxy--the-edge)).

---

## 3. Authorization

Write endpoints require the **operator** role once auth lands
([security](./spec-platform-security.md), **2b**); in the unauthenticated 2a MVP the
setpoint-edit and registration endpoints are open on the trusted local network
([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
The per-surface capability split (viewer reads; operator reads + writes) is owned by
[security](./spec-platform-security.md#4-capability-matrix).

---

## 4. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| What the telemetry queries read | reads | [`spec-platform-ingestion.md`](./spec-platform-ingestion.md), [`spec-platform-data-model.md`](./spec-platform-data-model.md) |
| What profiles/assignments/setpoints drive | drives | [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) |
| Who consumes the WebSocket stream | served to | [`spec-platform-dashboard.md`](./spec-platform-dashboard.md), [frontend data model](../frontend/spec-frontend-data-model.md) |
| Which role may call what | gated by | [`spec-platform-security.md`](./spec-platform-security.md) |
| Concrete routes, payloads, status codes | defers to | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md) |
