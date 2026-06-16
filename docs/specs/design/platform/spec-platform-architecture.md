# Platform — Architecture

> **Purpose:** Define *how the platform's pieces connect* — the container topology,
> the Go API hub, the three data flows that cross it, and the single nginx edge that
> fronts the whole stack. This is the structural view; each concern's *behavior* is
> owned by its own document (ingestion, crop profiles, API surface, operations) and
> linked from the [cross-spec map](#5-cross-spec-map). Service-deployment detail
> (Compose, controller generation) lives in
> [operations](./spec-platform-operations.md#2-deployment); ingress is fixed by
> [RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress).

---

## 1. Container topology

A set of containers behind a single reverse proxy. The Go API is the hub: it ingests
from MQTT, persists to TimescaleDB, serves the dashboard, and drives the controllers'
REST APIs.

```
                       +------------------------------+
                       |   Frontend (React SPA)       |
                       +---------------+--------------+
                                       | HTTP / WS
                                       v
       +----------------+      +------------------------------+
       |  Auth          |<---->|   Reverse Proxy (nginx)      |
       |  Keycloak/OIDC |      +---------------+--------------+
       +----------------+                      |
                                               v
                              +------------------------------+   /metrics   +-------------------+
                              |   Go API (Echo)              |<-------------|  Prometheus       |
                              |  - Telemetry ingestion       |   (scrape)   |  + Grafana (dash) |
                              |  - Fleet / device registry   |              +-------------------+
                              |  - Crop profiles → setpoints |
                              |  - Ad-hoc setpoint edits     |
                              |  - Analytics endpoints       |
                              |  - WebSocket fan-out         |
                              |  - /metrics + structured logs|
                              +----+--------------------+----+
                          DB / SQL |                    | MQTT (ingest) + REST (control, down)
                                   v                    v
                       +----------------------+   +------------------+
                       | TimescaleDB          |   |  MQTT Broker     |
                       | - registry + profiles|   |  Mosquitto       |
                       | - telemetry (TSDB)   |   +--------+---------+
                       +----------------------+           |
                                                          |  MQTT (up) ↑   REST (down) ↓
                                         +----------------+----------------+
                                         |                |                |
                                 Phase 1 Controller  Phase 1 Controller  Phase 1 Controller
                                  (greenhouse A)       (greenhouse B)      (greenhouse N)
```

---

## 2. The Go API is the hub

Every responsibility that touches state runs in the Go API; the other containers are
transport, storage, identity, or presentation around it. This deliberate hub-and-spoke
shape keeps the platform's logic in one cohesive service and the boundaries thin:

| Component | Responsibility |
|---|---|
| Reverse Proxy (nginx) | Single entry point; routes to API and frontend; auth edge ([§4](#4-reverse-proxy--the-edge)) |
| Go API (Echo) | Ingestion, fleet management, profile resolution, setpoint edits, analytics, WS fan-out |
| TimescaleDB | Relational registry + crop profiles; time-series telemetry & events ([data model](./spec-platform-data-model.md)) |
| MQTT Broker (Mosquitto) | Transport for controller telemetry (ingest only) |
| Auth (Keycloak) *(2b)* | OIDC identity provider — login, user store, roles; the API validates its tokens ([security](./spec-platform-security.md)) |
| Frontend | React dashboard — fleet overview, per-greenhouse detail, profile & control UI ([dashboard](./spec-platform-dashboard.md)) |
| Observability *(2b)* | Prometheus scrape + Grafana dashboards over the API's `/metrics`; structured logs ([operations](./spec-platform-operations.md)) |

The API never lets a peer reach another peer directly: the frontend never speaks MQTT
or the controller REST API, and a controller never speaks SQL. Everything funnels
through the API, which is the only component that holds the platform's identity map
(which `greenhouse_id` lives at which MQTT topic root and REST base URL).

---

## 3. Three data flows

Three flows cross this topology; each is owned by a dedicated document:

- **Telemetry (up):** controllers publish over MQTT → API ingests → time-series store
  ([ingestion](./spec-platform-ingestion.md)).
- **Control (down):** API resolves profiles / relays operator actions → each
  controller's REST API ([crop profiles](./spec-platform-crop-profiles.md)). The API
  writes only *targets* — never actuator commands.
- **Dashboard:** frontend ↔ API over HTTP + WebSockets, through the proxy, gated by
  auth in 2b ([API surface](./spec-platform-interfaces.md#3-api-surface-inventory),
  [security](./spec-platform-security.md)).

The flows are directional and never mixed: MQTT is telemetry-only (up), all control
is REST (down), per
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
and [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).
See [interfaces](./spec-platform-interfaces.md) for the integration contract.

---

## 4. Reverse proxy & the edge

A single **nginx** container is the platform's one entry point — chosen over Traefik
because the service map is static and config-driven
([RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress)).
Fronting everything with one proxy mirrors a real PaaS ingress while keeping local
networking to a **single exposed port**.

nginx has two jobs:

- **Serve the SPA** — the built React app's static assets are served directly by
  nginx (no Node runtime). Unmatched paths fall back to `index.html` so client-side
  deep links resolve ([frontend architecture](../frontend/spec-frontend-architecture.md)).
- **Reverse-proxy the API** — inbound API calls are proxied to the Go API, including
  the **WebSocket upgrade** (`Connection: upgrade` / `Upgrade: websocket`) the live
  channel depends on.

### Route map

| Route | Target | Slice | Notes |
|---|---|---|---|
| `/` and SPA asset paths | nginx static (`dist/`) | 2a | `index.html` fallback for deep links |
| `/api` (REST) | Go API | 2a | request/response |
| `/api` (WebSocket) | Go API | 2a | upgrade headers passed through; long-lived |
| `/auth` | Keycloak | 2b | login / token endpoints, added with authentication |

In **2a** that is the whole job (SPA + `/api`); the `/auth` route to Keycloak and the
auth edge are added in **2b** with authentication
([security](./spec-platform-security.md)). The proxy applies gzip and cache headers to
static assets to meet the dashboard's initial-load target (`P2-USE-1`).

**Out of scope locally:** TLS termination and certificate management. The stack runs
on a trusted local Docker network on a single host
([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries));
fronting it with HTTPS is a deployment-environment concern, not a platform-design one.

---

## 5. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| What state flows through the hub | routes to | [`spec-platform-data-model.md`](./spec-platform-data-model.md) |
| Telemetry-up flow | frames | [`spec-platform-ingestion.md`](./spec-platform-ingestion.md) |
| Control-down flow | frames | [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) |
| API + WebSocket responsibilities | frames | [`spec-platform-interfaces.md`](./spec-platform-interfaces.md#3-api-surface-inventory) |
| Auth at the proxy edge | sets up | [`spec-platform-security.md`](./spec-platform-security.md) |
| How the containers are deployed | sets up | [`spec-platform-operations.md`](./spec-platform-operations.md#2-deployment) |
| Ingress technology choice | defers to | [RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress) |
| Per-dependency choices | defers to | [`spec-platform-tech-stack.md`](./spec-platform-tech-stack.md) |
