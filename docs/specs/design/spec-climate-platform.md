# Phase 2 — Multi-Greenhouse Management Platform (Spec)

Architectural specification for the Phase 2 platform: how it aggregates telemetry from many Phase 1
controllers, stores history, manages the fleet, and **owns crop profiles — resolving them into each
controller's setpoints**. This describes the **software platform**. For the physical world it manages
— the site and its independent greenhouses — see
[`physical-system-multi.md`](./physical-system-multi.md); for the controller it manages each
greenhouse with, see [`spec-climate-controller.md`](./spec-climate-controller.md).

> Scope note: this is an architectural spec (services, responsibilities, behavior, data model).
> Concrete code/schema/struct design is deferred until implementation. Wire formats (MQTT topics,
> payload schemas, controller REST shapes) are **referenced**, not redefined here — they live in
> [`contracts/`](../../../contracts/), the single source of truth all three phases conform to.

---

## 1. Overview

Phase 2 is a **local, containerized management platform** for a single
[site](./physical-system-multi.md#the-site) — a collection of independent greenhouses, each run by
its own Phase 1 controller. It is the operator's one place to oversee the whole site: it ingests and
stores every greenhouse's telemetry, presents a dashboard, manages the fleet, and is the authority on
**what each greenhouse should be held at**.

The site is [homogeneous in capability but heterogeneous in configuration](./physical-system-multi.md#site-topology):
identical hardware in every house, but a different [crop](./physical-system-multi.md#crop) — and so a
different ideal climate — growing in each. That heterogeneity is what makes a management platform
worthwhile, and it is why the platform **owns crop profiles**: it turns "this is a lettuce house,
fruiting stage" into the numeric setpoints the [crop-agnostic controller](./spec-climate-controller.md#4-configuration--setpoints)
regulates to.

The platform is **bidirectional**:

- **Up** — it ingests telemetry (readings, actuator states, fault events) from every controller over
  MQTT and stores the history.
- **Down** — it resolves crop profiles into controller setpoints and applies operator setpoint edits
  to any controller over that controller's REST API — all as reconciled **intended state**. The
  platform writes only *targets*; it never commands actuators directly.

Everything runs locally under Docker Compose — zero cloud dependency. The platform **manages**
greenhouses; it does **not** couple their physics. There is no shared air mass, shared sensing, or
[site-wide orchestration](./physical-system-multi.md#out-of-scope-for-this-site-model) — each
greenhouse remains an independent climate and failure domain. Cross-greenhouse intelligence
(optimization, weather) belongs to later phases — see [§14](#14-scope--deferred--out-of-scope).

---

## 2. Architecture

A set of containers behind a single reverse proxy. The Go API is the hub: it ingests from MQTT,
persists to Postgres/TimescaleDB, serves the dashboard, and drives the controllers' REST APIs.

```
                       +------------------------------+
                       |   Frontend (React SPA)       |
                       +---------------+--------------+
                                       | HTTP / WS
                                       v
       +----------------+      +------------------------------+
       |  Auth          |<---->|   Reverse Proxy (Traefik)    |
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
                       | Postgres/TimescaleDB |   |  MQTT Broker     |
                       | - registry + profiles|   |  EMQX/Mosquitto  |
                       | - telemetry (TSDB)   |   +--------+---------+
                       +----------------------+           |
                                                          |  MQTT (up) ↑   REST (down) ↓
                                         +----------------+----------------+
                                         |                |                |
                                 Phase 1 Controller  Phase 1 Controller  Phase 1 Controller
                                  (greenhouse A)       (greenhouse B)      (greenhouse N)
```

Three data flows cross this topology:

- **Telemetry (up):** controllers publish over MQTT → API ingests → time-series store.
- **Control (down):** API resolves profiles / relays operator actions → each controller's REST API.
- **Dashboard:** frontend ↔ API over HTTP + WebSockets, through the proxy, gated by auth.

| Component | Responsibility |
|---|---|
| Reverse Proxy | Single entry point; routes to API and frontend; auth edge |
| Go API (Echo) | Ingestion, fleet management, profile resolution, setpoint edits, analytics, WS fan-out |
| Postgres/TimescaleDB | Relational registry + crop profiles; time-series telemetry & events |
| MQTT Broker | Transport for controller telemetry (ingest) |
| Auth (Keycloak) | OIDC identity provider — login, user store, roles; the API validates its tokens |
| Frontend | React dashboard — fleet overview, per-greenhouse detail, profile & control UI |
| Observability | Prometheus scrape + Grafana dashboards over the API's `/metrics`; structured logs |

---

## 3. Data Model

The platform keeps two kinds of state, in one Postgres instance — with the **TimescaleDB extension**
enabled for the time-series tables (it is a Postgres extension, not a separate database):

**Relational (configuration & metadata)** — low-volume, mutable, strongly related:

| Entity | Purpose |
|---|---|
| Site | The logical grouping of greenhouses run as one operation |
| Greenhouse (registry) | One row per greenhouse: identity, display name, the crop it grows |
| Controller endpoint | How to reach a greenhouse's controller (MQTT topic root, REST base URL), liveness |
| Crop profile | A named, **stage-aware** bundle of climate + irrigation targets for a crop |
| Profile target bundle | The actual values — mirrors the controller's **runtime-adjustable** config: the climate `[setpoints]` (temperature day/night, humidity band, VPD, DLI, CO₂) **plus** per-zone soil-moisture thresholds + watering schedule |
| Profile assignment | Which profile (and growth stage) is currently assigned to a greenhouse |
| User / role | Identity and access level (see [§9](#9-authentication--authorization)) |

**Time-series (telemetry & events)** — high-volume, append-only:

| Stream | Contents |
|---|---|
| Sensor readings | Per-greenhouse fused/raw readings over time (temperature, humidity, CO₂, PAR, per-zone soil moisture) |
| Actuator states | Commanded/observed actuator positions over time |
| Events | Fault events, safety-interlock activations, profile applications, setpoint edits |

The split is deliberate: crop profiles, the registry, and assignments are relational because they are
small, edited by hand, and heavily cross-referenced; telemetry is time-series because it is
high-frequency, append-only, and queried by range. The profile target bundle intentionally
**mirrors the controller's runtime-adjustable config** so that resolving a profile is a direct
mapping, not a translation — keeping the contract between platform and controller thin.

> **Boundary — zone topology is controller-local.** The bundle covers only what the controller
> exposes at *runtime*: climate setpoints and per-zone irrigation thresholds/schedule. Zone
> *structure* — adding or removing [zones](./physical-system-single.md#zones) — is a config-file +
> restart change on the controller ([P1 §4](./spec-climate-controller.md#4-configuration--setpoints))
> and is **not** in the platform's write path.

---

## 4. Telemetry Ingestion

The API subscribes to the controllers' MQTT topics (topic map defined in
[`contracts/mqtt`](../../../contracts/mqtt/)) and writes what it receives into the time-series store.

- **Per-greenhouse routing** — each controller publishes under its own topic root; the ingester maps
  topic → greenhouse via the registry's controller-endpoint record.
- **Streams ingested** — sensor readings, actuator states, and fault/state events (the same surface
  the controller publishes in [P1 spec §11](./spec-climate-controller.md#11-interfaces)).
- **QoS & retained** — readings use the QoS the contract specifies; retained system-state/last-will
  messages let the platform recover a controller's current state on (re)connect without waiting for
  the next sample.
- **Liveness / health** — absence of expected messages (or an MQTT last-will) marks a greenhouse
  **offline**; ingested fault events mark it **degraded**. Per-greenhouse status is derived here and
  surfaced to the fleet view and reconciliation ([§5](#5-crop-profiles--setpoint-resolution)).
- **Retention & downsampling** — telemetry is append-only and grows without bound, so the time-series
  store needs a **retention policy** (and optionally continuous aggregates / downsampling for
  long-range dashboard queries). The specific horizon is an implementation/config choice, not fixed
  by this spec.

Ingestion is **read-only with respect to the greenhouse**: it never changes a controller. All
downward writes go through the control path in [§5](#5-crop-profiles--setpoint-resolution) and
[§6](#6-fleet-management--operator-control).

---

## 5. Crop Profiles & Setpoint Resolution

This is the platform's defining responsibility. A controller is
[crop-agnostic](./spec-climate-controller.md#4-configuration--setpoints) — it regulates to whatever
numbers it is given. The platform owns the layer above: turning a crop (and its growth stage) into
those numbers, and keeping the controller faithful to them.

### Profiles and assignment

- A **crop profile** is a named, stage-aware bundle of targets — e.g. *lettuce / vegetative* → its
  temperature day/night, humidity band, VPD, DLI, and CO₂ targets, **plus** the per-zone soil-moisture
  thresholds and watering schedule that crop wants. Profiles form a small library, editable in the
  dashboard.
- A greenhouse has exactly **one active assignment** at a time: a profile + the current growth stage.
  Advancing the stage (propagation → vegetative → fruiting) re-selects the stage's target bundle.

### Resolution and the write path

Applying an assignment **resolves** the profile's target bundle into the controller's setpoints and
pushes them down via the controller's REST config API — the runtime `PATCH` path described in
[P1 spec §4](./spec-climate-controller.md#4-configuration--setpoints). Because the target bundle
mirrors the controller's `[setpoints]` schema ([§3](#3-data-model)), resolution is a direct mapping.

### Reconciliation — the platform is the source of truth

The platform does not fire-and-forget. It holds an **intended state** for each greenhouse — the
resolved profile **plus** any sticky operator setpoint edits layered on top ([§6](#6-fleet-management--operator-control))
— and continuously keeps the live controller matching it:

- **Apply on change** — assigning a profile or editing its targets pushes the new setpoints down.
- **Re-assert on reconnect** — when a controller comes back online ([§4](#4-telemetry-ingestion)),
  the platform re-pushes the intended setpoints so a restarted controller cannot silently revert to
  its local TOML defaults. If a controller is **offline** when its intended state changes, the change
  is held and applied on reconnect rather than lost.
- **Drift detection** — the platform compares the controller's reported setpoints (from telemetry /
  its REST status) against the intended state. A mismatch is surfaced as **drift** in the fleet
  view and may be auto-corrected by re-applying. This catches out-of-band local edits.

### Boundary with Phase 3

The platform owns the **static** mapping — "this crop, this stage → these targets." Phase 3 later
**refines** those targets dynamically (anticipatory, cost-aware) within crop-safe bounds; that
optimization is out of scope here. See [§14](#14-scope--deferred--out-of-scope).

---

## 6. Fleet Management & Operator Control

Beyond profiles, the platform is the operator's single pane of glass for acting on any greenhouse.

- **Device registry** — greenhouses and their controller endpoints are **registered manually** via
  the API/dashboard (the platform does not auto-discover controllers); this registry is the bootstrap
  that ingestion and resolution key off. Greenhouses can also be retired.
- **Status aggregation** — per-greenhouse online/degraded/drift status (from [§4](#4-telemetry-ingestion)
  and [§5](#5-crop-profiles--setpoint-resolution)) rolled up into a site-wide fleet view.
- **Ad-hoc setpoint edits** — the operator's manual control surface: a one-off setpoint change outside
  the assigned profile, relayed to the controller's REST config API. Because the platform is the
  source of truth, such an edit becomes a **sticky** part of the greenhouse's intended state (layered
  over the profile, flagged as deliberate drift), so reconciliation does not immediately revert it.
  It follows the same offline handling as profile resolution — held and re-asserted on reconnect
  ([§5](#5-crop-profiles--setpoint-resolution)). The platform's downward control is **setpoint-only**;
  it does not force individual actuators (see [§14](#14-scope--deferred--out-of-scope)).
- **Change attribution** — every downward write (profile application, ad-hoc setpoint edit) is
  recorded as an event with who/what/when, for audit and for the dashboard's activity view.

> **Safety stays in the controller.** The platform only ever sets *targets* (profile or ad-hoc
> setpoints) — it never commands actuators directly, so it has no imperative path that could drive an
> unsafe state. The controller's critical-temp and CO₂-ceiling
> [interlocks](./spec-climate-controller.md#7-safety-interlocks) keep unconditional priority **inside
> the controller** and bound actual actuation regardless of which setpoints the platform pushes. The
> platform observes and reports interlock activations; it never overrides them.

---

## 7. API Surface

The Go API exposes REST for request/response and WebSockets for live push. This lists
responsibilities only; concrete routes and payloads are deferred to [`contracts/`](../../../contracts/).

| Surface | Role |
|---|---|
| **REST — greenhouses** | Register/retire greenhouses; read fleet + per-greenhouse status |
| **REST — crop profiles** | CRUD on the profile library and their stage-aware target bundles |
| **REST — assignments** | Assign a profile/stage to a greenhouse; trigger apply/reconcile |
| **REST — telemetry** | Range queries over historical readings/actuator states/events |
| **REST — analytics** | Aggregations and derived series for dashboards |
| **REST — setpoint edits** | Ad-hoc setpoint edits, proxied to controllers as sticky intended state |
| **WebSockets** | Live fan-out of telemetry, status changes, drift, and events to the dashboard |

Write endpoints (assignments, setpoint edits) require the **operator** role
([§9](#9-authentication--authorization)).

---

## 8. Dashboard (Frontend)

A React single-page app, served through the reverse proxy, talking to the API over HTTP + WebSockets:

- **Fleet overview** — every greenhouse at the site, its crop, status (online/degraded/drift), and a
  glance at current climate vs target.
- **Per-greenhouse detail** — real-time charts of readings vs setpoints, actuator states, and event
  history, fed by the WebSocket stream.
- **Profile management** — browse/edit the crop-profile library; assign a profile + growth stage to a
  greenhouse and apply it.
- **Control** — issue ad-hoc setpoint edits (operator role); actuator-level forcing is not offered
  here — it stays a controller-local action ([§14](#14-scope--deferred--out-of-scope)).
- **Health surfacing** — drift, faults, offline controllers, and interlock activations raised
  prominently.

---

## 9. Authentication & Authorization

Identity is delegated to **Keycloak**, a self-hosted **OIDC identity provider** that runs as a
container in the stack ([§12](#12-deployment)) — no cloud dependency. Keycloak owns the user store,
login, password policies, and (optionally) MFA, so the Go API never handles credentials itself.

The split of responsibility:

- **Authentication → Keycloak.** Users log in against Keycloak; it issues OIDC tokens. The API is an
  OIDC **relying party** — it validates those tokens and trusts the identity + roles they carry.
- **Authorization → the API.** Which role may do what is enforced in the API by mapping Keycloak
  roles onto the platform's two roles below. This authorization model is independent of Keycloak's
  internals, so the identity provider and the capability rules evolve separately.

Two roles are sufficient for the platform:

| Role | Capability |
|---|---|
| Viewer | Read fleet, telemetry, analytics, status |
| Operator | All of Viewer **plus** every write-path action (assign/apply profiles, ad-hoc setpoint edits) |

Finer-grained RBAC and multi-tenant identity are out of scope ([§14](#14-scope--deferred--out-of-scope)).

---

## 10. Reverse Proxy & Routing

A single reverse proxy (**Traefik or nginx**) is the platform's one entry point. It routes inbound
requests to the frontend (static SPA assets) and to the Go API (REST + WebSocket upgrade), and is the
natural place to terminate the auth edge. Running everything behind one proxy mirrors a real PaaS
ingress while keeping local networking to a single exposed port.

---

## 11. Observability

The platform instruments **itself**, distinct from the greenhouse telemetry it ingests:

- **Metrics** — the Go API exposes `/metrics`; **Prometheus** scrapes it; **Grafana** renders
  platform dashboards (ingestion rate, API latency/errors, reconciliation actions, per-controller
  connectivity).
- **Structured logs** — the API emits structured logs (Go `slog`) for operational events and audit
  trail.

This is **platform health**, not crop climate: greenhouse readings live in the time-series store and
the dashboard ([§3](#3-data-model), [§8](#8-dashboard-frontend)); `/metrics` is about the service.

---

## 12. Deployment

The whole platform is one **Docker Compose** stack — single-command local orchestration, no cloud
account.

| Service | Implementation |
|---|---|
| `api` | Go + Echo |
| `db` | PostgreSQL (optionally TimescaleDB) |
| `mqtt` | EMQX or Mosquitto |
| `auth` | Keycloak — self-hosted OIDC identity provider |
| `proxy` | Traefik or nginx |
| `frontend` | Built React app served via the proxy |

The platform's own service configuration — database DSN, MQTT broker address, Keycloak client
credentials, proxy routing — is supplied via **environment variables / the Compose file**, not a
per-greenhouse config (contrast the controller's TOML). Per-greenhouse data lives in the registry and assignments.

Each Phase 1 controller connects to this stack over **two channels**: MQTT (telemetry up, into the
broker) and REST (control/config down, from the API). N controllers attach to one platform; nothing
about the platform is per-greenhouse except registry rows and assignments.

---

## 13. Interfaces & Integration with Phase 1

| Interface | Direction | Role |
|---|---|---|
| **MQTT** | Controller → platform | Telemetry ingest: readings, actuator states, fault/state events |
| **Controller REST** | Platform → controller | Setpoint resolution (profile apply/reconcile) + ad-hoc setpoint edits |
| **WebSockets** | Platform → frontend | Live fan-out of telemetry, status, drift, events |

The MQTT topic map and the controller REST shapes the platform depends on are owned by
[`contracts/`](../../../contracts/) and the [P1 spec §11](./spec-climate-controller.md#11-interfaces);
this spec consumes those contracts rather than defining them.

---

## 14. Scope — Deferred / Out of Scope

Platform capabilities intentionally **not** in Phase 2:

| Deferred / excluded | Why / where it belongs |
|---|---|
| AI optimization & **setpoint refinement** | Dynamic, anticipatory, cost-aware tuning of the crop-profile baseline — **Phase 3**. Phase 2 owns only the static crop → targets mapping ([§5](#5-crop-profiles--setpoint-resolution)) |
| Weather / forecast feed | Live + forecast outdoor conditions and weather-reactive control — **Phase 4** (stretch goal); see [physical-system-multi.md](./physical-system-multi.md#weather-forecast) |
| Site-wide orchestration | Coordinated behavior across greenhouses (e.g. staggering loads) needs the shared-infrastructure / resource-contention model that is [out of scope for the site](./physical-system-multi.md#common-inputs--out-of-scope). Phase 2 aggregates and manages; it does not couple physics |
| Multi-site / multi-tenant | The platform manages a **single site**; multiple sites or tenants are not modeled |
| Advanced RBAC | Two roles (viewer/operator) only; fine-grained permissions and org hierarchies are out of scope ([§9](#9-authentication--authorization)) |
| Manual actuator override | Forcing individual actuators is a **controller-local** action ([P1 §10](./spec-climate-controller.md#10-manual-override)); the platform's downward control is **setpoint-only** and does not proxy actuator overrides |
| Safety authority | Safety interlocks remain **controller-owned** ([§6](#6-fleet-management--operator-control)); the platform never overrides them |
