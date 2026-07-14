# Platform — Dashboard

> **Purpose:** Define the dashboard's **capabilities** — what the operator can see and
> do — and the delivery slice each lands in. This file owns *what the dashboard is for*
> at the platform altitude; *how the SPA is built* (views, components, client
> architecture, tokens, interactions) is owned one level down by the
> [frontend spec set](../frontend/01-spec-frontend-overview.md). This is the ownership
> boundary: platform here says **what**, the frontend set says **how**.

A React single-page app, served through the
[reverse proxy](./02-spec-platform-architecture.md#4-reverse-proxy--the-edge), talking to
the API over HTTP + WebSockets ([API surface](./09-spec-platform-interfaces.md#3-api-surface-inventory)). It is
the **only frontend in the system** and serves **one or more** greenhouses — a single
greenhouse is the fleet-of-one case. Its monitoring and setpoint-edit core ships in
**2a**; profile management follows in **2b**.

---

## 1. Capabilities

- **Fleet overview** *(2a)* — every greenhouse at the site, its crop, status
  (online/degraded/drift), and a glance at current climate. Target setpoints are shown on the
  per-greenhouse detail, not the fleet card.
- **Per-greenhouse detail** *(2a)* — real-time charts of readings vs setpoints,
  actuator states, and event history, fed by the WebSocket stream.
- **Profile management** *(2b)* — browse/edit the crop-profile library; assign a
  profile + growth stage to a greenhouse and apply it
  ([crop profiles](./05-spec-platform-crop-profiles.md)).
- **Control** *(2a)* — issue ad-hoc setpoint edits (operator role once auth lands in
  2b); actuator-level forcing is not offered here — it stays a controller-local action
  ([constraints](./11-spec-platform-constraints.md)).
- **Health surfacing** *(2a)* — faults, offline controllers, and interlock activations
  raised prominently (drift surfacing arrives with reconciliation in 2b).
- **Optimizer operator console** *(3)* — review the Phase 3 optimizer's proposed/applied
  plans and its held-cycle **escalation** queue, see the proposed-vs-current setpoint diff,
  and act on the optimizer at runtime (resolve an escalation, trigger an on-demand cycle,
  switch the active model, pause/resume planning **service-wide or for one greenhouse**). All of it is surfaced and driven **through
  the Go API** ([API surface](./09-spec-platform-interfaces.md#3-api-surface-inventory)); the
  optimizer still refines setpoints only through the platform's single write path
  ([crop profiles](./05-spec-platform-crop-profiles.md)), so this console **observes and
  operates** the optimizer, it does not add a second control path.

---

## 2. Ownership boundary

This file deliberately stops at capabilities. The view inventory, route tree, client
data binding, component catalog, design tokens, and interaction model are all owned by
the [frontend spec set](../frontend/01-spec-frontend-overview.md):

- *Why it exists and which views* → [frontend purpose & views](../frontend/02-spec-frontend-purpose-and-views.md)
- *How the client is structured* → [frontend architecture](../frontend/03-spec-frontend-architecture.md)
- *Data shapes + API/WS binding* → [frontend data model](../frontend/05-spec-frontend-data-model.md)

If a capability is named here, its realization lives there.

---

## 3. Testing

The SPA is validated with **Playwright** (E2E flows + live-update latency over the
WebSocket stream) and **Lighthouse CI** (initial-load performance + accessibility, run
against the production build). See
[tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only)
and the `P2-USE-1` / `P2-TEST-2` targets in
[non-functional-requirements.md](../../artifacts/non-functional-requirements.md).

---

## 4. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| How the SPA is built (views, components, tokens, interactions) | defers to | [frontend set](../frontend/01-spec-frontend-overview.md) |
| The API + WebSocket surface it consumes | consumes | [`09-spec-platform-interfaces.md`](./09-spec-platform-interfaces.md#3-api-surface-inventory) |
| The profile/assignment actions it drives | drives | [`05-spec-platform-crop-profiles.md`](./05-spec-platform-crop-profiles.md) |
| Role-gating of write actions | gated by | [`07-spec-platform-security.md`](./07-spec-platform-security.md) |
| Load / latency / a11y / test targets | defers to | [NFR doc](../../artifacts/non-functional-requirements.md) |
