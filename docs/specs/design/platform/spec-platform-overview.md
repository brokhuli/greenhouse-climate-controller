# Platform Spec — Overview & Index

> **Purpose:** This is the entry point and anchor for the **Phase 2
> multi-greenhouse management platform** spec set. It says what the platform is,
> how it ships across the 2a/2b delivery slices, how it connects to everything
> around it, and — via the [cross-spec map](#6-cross-spec-map) — which document
> owns which concern. Read this file first; read the others for detail.

This set is the **top-level design spec for Phase 2**. It sits alongside the
[controller](../controller/01-spec-controller-overview.md),
[optimizer](../optimizer/01-spec-optimizer-overview.md), and [Phase 4](../spec-phase4.md) specs,
one altitude **above** the wire contracts in
[`contracts/`](../../../../contracts/), and one altitude **above** the
[frontend spec set](../frontend/01-spec-frontend-overview.md), which owns *how the
dashboard SPA is built*. The discipline throughout mirrors those sibling sets:
**reference, do not redefine.** Wire formats live in
[`contracts/`](../../../../contracts/); the physical world being managed lives in
[`physical-system-multi.md`](../physical-system-multi.md); quality targets live in
the [NFR doc](../../artifacts/non-functional-requirements.md); cross-cutting
decisions live in the [RFCs](../../../decisions/request-for-comments.md) and
[ADRs](../../../decisions/architecture-design-record.md). This set consumes all of
them.

---

## 1. What the platform is

Phase 2 is a **local, containerized management platform** for a single
[site](../physical-system-multi.md#the-site) — a collection of independent
greenhouses, each run by its own Phase 1 controller. It is the operator's one place
to oversee the whole site: it ingests and stores every greenhouse's telemetry,
presents a dashboard, manages the fleet, and is the authority on **what each
greenhouse should be held at**.

The site is [homogeneous in capability but heterogeneous in configuration](../physical-system-multi.md#site-topology):
identical hardware in every house, but a different [crop](../physical-system-multi.md#crop)
— and so a different ideal climate — growing in each. That heterogeneity is what
makes a management platform worthwhile, and it is why the platform **owns crop
profiles**: it turns "this is a lettuce house, fruiting stage" into the numeric
setpoints the [crop-agnostic controller](../controller/07-spec-controller-config-and-parameters.md)
regulates to.

The platform is **bidirectional**:

- **Up** — it ingests telemetry (readings, actuator states, fault events) from every
  controller over MQTT and stores the history
  ([ingestion](./spec-platform-ingestion.md)).
- **Down** — it resolves crop profiles into controller setpoints and applies
  operator setpoint edits to any controller over that controller's REST API — all as
  reconciled **intended state** ([crop profiles](./spec-platform-crop-profiles.md)).
  The platform writes only *targets*; it never commands actuators directly.

Everything runs locally under Docker Compose — zero cloud dependency. The platform
**manages** greenhouses; it does **not** couple their physics. There is no shared
air mass, shared sensing, or [site-wide orchestration](../physical-system-multi.md#out-of-scope-for-this-site-model)
— each greenhouse remains an independent climate and failure domain. Cross-greenhouse
intelligence (optimization, weather) belongs to later phases — see
[constraints](./spec-platform-constraints.md).

Because Phase 1 controllers are [headless](../controller/08-spec-controller-interfaces.md),
this platform's frontend is the **only UI in the system** — it monitors **one or
more** controllers, a single greenhouse being the fleet-of-one case.

---

## 2. Delivery slices (2a / 2b)

Phase 2 ships in two slices. **2a** is the MVP that lets the frontend talk to a
controller in both directions — the telemetry pipeline plus a thin setpoint-edit
relay, **unauthenticated** on the trusted local Docker network. **2b** adds the
platform's defining crop-profile/reconciliation machinery, authentication, and
observability. Every document in this set tags sections **(2a)** / **(2b)** to
match; the boundary is recorded in
[ADR 2026-06-11](../../../decisions/architecture-design-record.md).

| Capability | Slice |
|---|---|
| Mosquitto broker; TimescaleDB (telemetry + minimal greenhouse/endpoint registry) | **2a** |
| Telemetry ingestion → store ([ingestion](./spec-platform-ingestion.md)) | **2a** |
| Greenhouse/endpoint registration + status aggregation ([crop profiles — fleet](./spec-platform-crop-profiles.md#5-fleet-management--operator-control)) | **2a** |
| Ad-hoc setpoint edits relayed to the controller REST API ([crop profiles — fleet](./spec-platform-crop-profiles.md#5-fleet-management--operator-control)) | **2a** |
| API: telemetry queries, WebSocket fan-out ([API surface](./spec-platform-interfaces.md#3-api-surface-inventory)) | **2a** |
| nginx serving the SPA + proxying `/api` ([architecture — reverse proxy](./spec-platform-architecture.md#4-reverse-proxy--the-edge)) | **2a** |
| Dashboard: fleet overview, per-greenhouse detail, setpoint-edit control ([dashboard](./spec-platform-dashboard.md)) | **2a** |
| Crop profiles + setpoint **resolution**; profile-management UI ([crop profiles](./spec-platform-crop-profiles.md), [dashboard](./spec-platform-dashboard.md)) | **2b** |
| Reconciliation / drift detection / re-assert on reconnect ([crop profiles](./spec-platform-crop-profiles.md)) | **2b** |
| Keycloak OIDC + viewer/operator roles + nginx `/auth` ([security](./spec-platform-security.md), [architecture](./spec-platform-architecture.md#4-reverse-proxy--the-edge)) | **2b** |
| Single-authority `POST /setpoints` (optimizer write path, RFC-005) + provenance ([crop profiles](./spec-platform-crop-profiles.md), [API surface](./spec-platform-interfaces.md#3-api-surface-inventory)) | **2b** |
| Prometheus + Grafana observability ([operations](./spec-platform-operations.md)) | **2b** |

In 2a, an ad-hoc setpoint edit is a **thin relay** (operator edit → Go API →
controller REST `PATCH /setpoints`); the full setpoint-authority layer — crop-safe
bounds, provenance, the optimizer-facing `POST /setpoints`, and reconciliation —
arrives in 2b. The split changes no committed interface and leaves
[RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)
intact.

---

## 3. System context

A set of containers behind a single reverse proxy. The Go API is the hub: it ingests
from MQTT, persists to TimescaleDB, serves the dashboard, and drives the controllers'
REST APIs.

```
        Frontend (React SPA)  ─ HTTP/WS ─┐
                                         ▼
   Auth (Keycloak/OIDC, 2b) ◀──▶  Reverse Proxy (nginx)
                                         │
                                         ▼
            Prometheus+Grafana ─/metrics─ Go API (Echo)  ── the hub
                                         │            │
                                  DB/SQL │            │ MQTT (ingest, up)
                                         ▼            │ REST (control, down)
                                  TimescaleDB    MQTT Broker (Mosquitto)
                                                      │
                              Phase 1 controllers × N (greenhouse A … N)
```

Three data flows cross this topology (detail in
[architecture](./spec-platform-architecture.md)):

- **Telemetry (up):** controllers publish over MQTT → API ingests → time-series store.
- **Control (down):** API resolves profiles / relays operator actions → each
  controller's REST API.
- **Dashboard:** frontend ↔ API over HTTP + WebSockets, through the proxy, gated by
  auth (2b).

---

## 4. Reading order

1. **This file** — orientation + cross-spec map.
2. [`spec-platform-architecture.md`](./spec-platform-architecture.md) — *how the
   pieces connect*: container topology, the hub model, data flows, and the nginx
   edge.
3. [`spec-platform-data-model.md`](./spec-platform-data-model.md) — *what state the
   platform keeps*: relational config + time-series telemetry.
4. [`spec-platform-ingestion.md`](./spec-platform-ingestion.md) — *telemetry up*:
   MQTT subscription, routing, liveness, retention.
5. [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) — *the
   defining responsibility*: profiles, resolution, reconciliation, and fleet/operator
   control.
6. [`spec-platform-dashboard.md`](./spec-platform-dashboard.md) — *the dashboard
   capabilities* (defers to the frontend set for how it's built).
7. [`spec-platform-security.md`](./spec-platform-security.md) — *identity & access*:
   Keycloak OIDC, viewer/operator roles.
8. [`spec-platform-operations.md`](./spec-platform-operations.md) — *running it*:
   observability + deployment.
9. [`spec-platform-interfaces.md`](./spec-platform-interfaces.md) — *interfaces &
   API surface*: the three cross-component interfaces (integration with Phase 1) and
   the served REST + WebSocket API.
10. [`spec-platform-tech-stack.md`](./spec-platform-tech-stack.md) — *what each
    dependency is and why*.
11. [`spec-platform-constraints.md`](./spec-platform-constraints.md) — *the
    non-negotiable rules* and what is out of scope.

---

## 5. Conventions used across the set

- **2a/2b tags** on every slice-specific section.
- **Reference, don't redefine.** A wire format owned by `contracts/`, a physical fact
  owned by [`physical-system-multi.md`](../physical-system-multi.md), a quality target
  owned by the NFR doc, or a decision owned by an RFC/ADR is *linked*, never restated.
- **NFR IDs** are cited by their stable ID (`P2-USE-1`, `P2-PERF-2`, `P2-PERF-3`,
  `P2-SEC-1`, `P2-SCAL-1`, `P2-TEST-2`, …) from the
  [NFR doc](../../artifacts/non-functional-requirements.md).
- **Relative links** resolve from `docs/specs/design/platform/`: sibling design specs
  and the physical-system docs at `../`, the controller/frontend sets at
  `../controller/` and `../frontend/`, artifacts at `../../artifacts/`, decisions at
  `../../../decisions/`, repo-root contracts at `../../../../contracts/`.

---

## 6. Cross-spec map

How this set divides the work, and where each concern is detailed:

| Concern | Owned by | Defers to |
|---|---|---|
| What the platform is; system context; this index | this file | [physical-system-multi](../physical-system-multi.md) |
| Container topology, the hub, data flows, the nginx edge/routing | [`spec-platform-architecture.md`](./spec-platform-architecture.md) | [RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress) |
| Relational config + time-series telemetry; the data split | [`spec-platform-data-model.md`](./spec-platform-data-model.md) | — |
| MQTT subscription, routing, liveness, retention, backpressure | [`spec-platform-ingestion.md`](./spec-platform-ingestion.md) | [`contracts/mqtt`](../../../../contracts/mqtt/), [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format) |
| Crop profiles, resolution, reconciliation; fleet & operator control | [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| Dashboard capabilities (not how it's built) | [`spec-platform-dashboard.md`](./spec-platform-dashboard.md) | [frontend set](../frontend/01-spec-frontend-overview.md) |
| Identity, roles, the auth edge | [`spec-platform-security.md`](./spec-platform-security.md) | [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) |
| Observability + deployment (Compose, controller generation, resource limits, perf testing) | [`spec-platform-operations.md`](./spec-platform-operations.md) | [NFR doc](../../artifacts/non-functional-requirements.md) |
| The three Phase 1 integration interfaces + REST/WebSocket API responsibilities | [`spec-platform-interfaces.md`](./spec-platform-interfaces.md) | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md), [controller interfaces](../controller/08-spec-controller-interfaces.md) |
| Per-dependency choices + rejected alternatives | [`spec-platform-tech-stack.md`](./spec-platform-tech-stack.md) | [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only) |
| Non-negotiable rules; scope / deferred capabilities | [`spec-platform-constraints.md`](./spec-platform-constraints.md) | [constraints artifact](../../artifacts/constraints.md), [NFR doc](../../artifacts/non-functional-requirements.md) |
| Quality targets (load, latency, scale, test) | [NFR doc](../../artifacts/non-functional-requirements.md) | — (single source) |

If a platform change can't be traced to one of these documents — or to the contracts
/ RFCs they reference — it doesn't belong in Phase 2.
