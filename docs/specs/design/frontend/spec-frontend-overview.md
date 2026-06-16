# Frontend Spec — Overview & Index

> **Purpose:** This is the entry point and anchor for the **platform dashboard
> frontend** spec set. It says what the dashboard is, how it ships across the
> 2a/2b delivery slices, how it connects to the rest of the system, and — via the
> [cross-spec map](#6-cross-spec-map) — which document owns which concern. Read
> this file first; read the others for detail.

This set sits **one altitude below** [`spec-platform-dashboard.md`](../platform/spec-platform-dashboard.md),
which owns the dashboard's *capabilities*. These documents own *how the SPA is
built*: views, client architecture, data binding, components, tokens,
interactions, and hard constraints. The discipline throughout: **reference, do
not redefine.** Wire formats live in [`contracts/`](../../../../contracts/);
capabilities and platform behavior live in the
[platform spec](../platform/spec-platform-overview.md); quality targets live in the
[NFR doc](../../artifacts/non-functional-requirements.md). This set consumes all
three.

---

## 1. What the dashboard is

The dashboard is the Phase 2 platform's **React single-page app** — and, because
Phase 1 controllers are [headless](../controller/spec-controller-interfaces.md),
the **only UI in the entire system**. It is the operator's single pane of glass
over a [site](../platform/spec-platform-overview.md) of independent
greenhouses: it visualizes live and historical telemetry, surfaces fleet health,
and is the operator's surface for the platform's downward control (setpoint edits
in 2a; crop-profile management in 2b).

It serves **one or more** greenhouses; a single greenhouse is the *fleet-of-one*
case, not a special mode. It is served as static assets by the platform's nginx
entry point and talks to the Go API over HTTP + WebSockets — **never** to MQTT or
to controllers directly (see [§3](#3-system-context)).

---

## 2. Delivery slices (2a / 2b)

The dashboard ships in the same two slices as the platform
([ADR 2026-06-11](../../../decisions/architecture-design-record.md)). Every
document in this set tags sections **(2a)** / **(2b)** to match.

| Frontend capability | Slice |
|---|---|
| App shell, fleet overview, per-greenhouse detail (live + historical charts) | **2a** |
| WebSocket live updates + connection-status / reconnect UX | **2a** |
| Ad-hoc setpoint-edit control (thin relay; unauthenticated) | **2a** |
| Health surfacing — faults, offline controllers, interlock activations | **2a** |
| Crop-profile library + editor; assign profile/stage to a greenhouse | **2b** |
| Drift surfacing (reconciliation) in fleet + detail views | **2b** |
| OIDC login + viewer/operator role-gating of write actions | **2b** |

In 2a the SPA runs **unauthenticated** on the trusted local Docker network
([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries));
a setpoint edit is a thin relay to the controller's REST API. 2b layers in
crop-profile authority, reconciliation/drift, and Keycloak auth — changing no
committed interface.

---

## 3. System context

The SPA is one box behind the platform's single
[nginx entry point](../platform/spec-platform-architecture.md#4-reverse-proxy--the-edge). It is
a pure client of the Go API.

```
                 ┌────────────────────────────┐
                 │   Browser — React SPA      │
                 │   (this spec set)          │
                 └─────────────┬──────────────┘
                       HTTP / WebSocket
                               │
              ┌────────────────▼─────────────────┐
   (2b) ◀────▶│        Reverse proxy (nginx)      │
  /auth       │   serves SPA assets; proxies      │
  Keycloak    │   /api (REST + WS upgrade), /auth  │
              └────────────────┬─────────────────┘
                               │  /api
                 ┌─────────────▼──────────────┐
                 │        Go API (Echo)        │
                 │  REST + WebSocket fan-out   │
                 └──────┬───────────────┬──────┘
                   SQL  │               │  MQTT (ingest, up) / REST (control, down)
                        ▼               ▼
                 TimescaleDB        Controllers (Phase 1) × N
```

The browser's entire contract is with the Go API: **REST** for request/response
(fleet, telemetry range queries, profiles, setpoint edits) and **WebSockets** for
live push (telemetry, status changes, drift, events). The SPA holds **no**
knowledge of MQTT topics or the controller REST API — those are platform-internal
([platform ingestion](../platform/spec-platform-ingestion.md),
[interfaces](../platform/spec-platform-interfaces.md)). See
[`spec-frontend-data-model.md`](./spec-frontend-data-model.md) for the binding.

---

## 4. Reading order

1. **This file** — orientation + cross-spec map.
2. [`spec-frontend-purpose-and-views.md`](./spec-frontend-purpose-and-views.md) —
   *why* it exists and *which views* it has.
3. [`spec-frontend-architecture.md`](./spec-frontend-architecture.md) — *how the
   pieces connect* (structure, routes, data flow).
4. [`spec-frontend-tech-stack.md`](./spec-frontend-tech-stack.md) — *what each
   dependency is and why*.
5. [`spec-frontend-data-model.md`](./spec-frontend-data-model.md) — *the data
   shapes* and their API/WS binding.
6. [`spec-frontend-components.md`](./spec-frontend-components.md) — *what each
   component is*.
7. [`spec-frontend-design-tokens.md`](./spec-frontend-design-tokens.md) — *the visual atoms*.
8. [`spec-frontend-interactions.md`](./spec-frontend-interactions.md) — *how it
   behaves*.
9. [`spec-frontend-constraints.md`](./spec-frontend-constraints.md) — *the
   non-negotiable rules*.

---

## 5. Conventions used across the set

- **2a/2b tags** on every slice-specific section.
- **Reference, don't redefine.** A capability owned by platform §8, a wire format
  owned by `contracts/`, or a quality target owned by the NFR doc is *linked*,
  never restated.
- **NFR IDs** are cited by their stable ID (`P2-USE-1`, `P2-PERF-2`, `P2-PERF-3`,
  `P2-SEC-1`, `P2-TEST-2`) from the
  [NFR doc](../../artifacts/non-functional-requirements.md).
- **Relative links** resolve from `docs/specs/design/frontend/`: sibling design
  specs at `../`, artifacts at `../../artifacts/`, decisions at
  `../../../decisions/`, repo-root contracts at `../../../../contracts/`.

---

## 6. Cross-spec map

How this set divides the work, and where each concern is detailed:

| Concern | Owned by | Defers upward to |
|---|---|---|
| Why the dashboard exists; the view inventory | [`spec-frontend-purpose-and-views.md`](./spec-frontend-purpose-and-views.md) | [platform dashboard](../platform/spec-platform-dashboard.md) |
| App structure, route tree, runtime data flow, failure modes | [`spec-frontend-architecture.md`](./spec-frontend-architecture.md) | [platform architecture](../platform/spec-platform-architecture.md), [reverse proxy](../platform/spec-platform-architecture.md#4-reverse-proxy--the-edge) |
| Per-dependency choices + rejected alternatives | [`spec-frontend-tech-stack.md`](./spec-frontend-tech-stack.md) | [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only) |
| Client data model + API/WS binding | [`spec-frontend-data-model.md`](./spec-frontend-data-model.md) | [platform API surface](../platform/spec-platform-interfaces.md#3-api-surface-inventory), [`contracts/`](../../../../contracts/) |
| Component inventory, props, states, role-gating | [`spec-frontend-components.md`](./spec-frontend-components.md) | — |
| Color, type, spacing, motion, chart tokens, themes | [`spec-frontend-design-tokens.md`](./spec-frontend-design-tokens.md) | — |
| Hover/focus/keyboard/motion + real-time interaction | [`spec-frontend-interactions.md`](./spec-frontend-interactions.md) | — |
| Non-negotiable rules (hosting, auth, safety, perf) | [`spec-frontend-constraints.md`](./spec-frontend-constraints.md) | [platform fleet management](../platform/spec-platform-crop-profiles.md#5-fleet-management--operator-control), [authentication](../platform/spec-platform-security.md), [constraints](../platform/spec-platform-constraints.md#7-scope--deferred--out-of-scope) |
| Quality targets (load, latency, a11y, test) | [NFR doc](../../artifacts/non-functional-requirements.md) | — (single source) |

If a frontend change can't be traced to one of these documents — or to the
platform spec / contracts / RFCs they reference — it doesn't belong in the SPA.
