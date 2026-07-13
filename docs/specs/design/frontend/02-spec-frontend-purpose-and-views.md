# Frontend — Purpose & Views

> **Purpose:** State *why* the dashboard exists and enumerate the *views* it must
> provide to fulfil that purpose. Other frontend specs derive from this one —
> [`06-spec-frontend-components.md`](./06-spec-frontend-components.md) builds the UI for
> these views, [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md)
> defines the data behind them, and
> [`03-spec-frontend-architecture.md`](./03-spec-frontend-architecture.md) routes
> between them. Capability detail is owned by
> [platform dashboard](../platform/06-spec-platform-dashboard.md); this file
> defers to it rather than restating it.

---

## Purpose

The dashboard makes a fleet of independent greenhouses **legible and operable
from one screen**. The site is
[homogeneous in hardware but heterogeneous in crop](../platform/01-spec-platform-overview.md):
every greenhouse runs an identical, [crop-agnostic controller](../controller/07-spec-controller-config-and-parameters.md)
but grows a different crop at a different stage, so each is held at different
targets. The operator needs to see, at a glance, whether every greenhouse is
healthy and tracking its targets — and to act on any one of them without leaving
the page.

Because the controllers are [headless](../controller/08-spec-controller-interfaces.md),
this SPA is the **only** window into the system and the **only** operator surface
for the platform's downward control. Its job is therefore two-sided:

- **Observe (up):** render live and historical telemetry, fleet health, and
  events, fed by the API's WebSocket stream and range queries.
- **Act (down):** let an operator change what a greenhouse is held at — ad-hoc
  setpoint edits in 2a, crop-profile assignment in 2b — always through the
  platform API, which remains the [single setpoint authority](../platform/05-spec-platform-crop-profiles.md).

It serves **one or more** greenhouses; a single greenhouse is the fleet-of-one
case, not a separate layout.

---

## Audience & roles

| Audience | What they do here | Role (2b) |
|---|---|---|
| Operator on shift | Watches fleet health, drills into a greenhouse, edits setpoints, assigns profiles | **Operator** |
| Grower / manager reviewing | Reads telemetry, history, and status; no changes | **Viewer** |

Until auth lands (**2b**, [platform authentication](../platform/07-spec-platform-security.md),
`P2-SEC-1`) the UI is open on the trusted local network and shows all actions. In
2b the **viewer** role sees a read-only dashboard; every write affordance
(setpoint edit, profile assign/apply) is gated to the **operator** role — see
[role-gating in components](./06-spec-frontend-components.md) and the
[login flow in interactions](./08-spec-frontend-interactions.md).

---

## What it must surface — the views

The dashboard is composed of the views below. Each maps to a capability in
[platform dashboard](../platform/06-spec-platform-dashboard.md); the slice tag
matches that section. For each: **purpose**, **what it shows**, **primary
actions**, **role**.

### 1. Fleet overview *(2a)*

- **Purpose:** the landing view — the whole site at a glance.
- **Shows:** every greenhouse as a card/row with its crop, connectivity status
  (online / degraded / offline; **drift** added in 2b), and a compact
  current-climate-vs-target readout (temperature, humidity, CO₂, and **DLI** — the day's
  accumulated light, rather than the instantaneous PAR, which the detail view still charts).
  Site-wide rollup of how many greenhouses are
  healthy vs need attention. On simulated controllers, each card also shows its
  current **simulation speed** (time-scale) when it is not 1×. In **Phase 3**, a compact
  **optimizer backlog** indicator flags greenhouses with an open escalation (held cycle
  awaiting review), linking into the [optimizer console](#6-optimizer-operator-console-3).
- **Primary actions:** open a greenhouse; (2a) register / retire a greenhouse
  (`RegisterGreenhouseDialog` / `RetireGreenhouseAction`, [components §3](./06-spec-frontend-components.md#3-primitives-components));
  *(2a, simulation-only)* set the simulation speed for the **whole fleet** at once
  (a convenience that fans out as independent per-controller writes — there is no
  shared clock; see [interactions §7](./08-spec-frontend-interactions.md#7-writes--setpoint-edits--profile-apply)).
- **Role:** Viewer (read) / Operator (registration, speed).

### 2. Per-greenhouse detail *(2a)*

- **Purpose:** the deep view of one greenhouse.
- **Shows:** real-time charts of readings vs setpoints (temperature, humidity,
  CO₂, PAR, per-zone soil moisture), current actuator states, and the event
  history — fed live by the WebSocket stream and backfilled by range queries over
  history. A summary readout surfaces the **active (Day / Night) temperature
  setpoint** with its label — which of the two day/night targets is currently in
  force, resolved from the greenhouse's clock against its day window. Alongside the
  per-zone soil-moisture chart, a **live per-zone irrigation status** panel shows,
  for each zone, its current moisture against the target band, whether it is
  **watering now**, whether it is **faulted**, and when it **last watered**. Active
  faults and interlock activations are raised prominently. Charts
  plot on **simulated time** (the controller's clock), and on a simulated controller
  a **speed indicator** shows the current time-scale. In **Phase 3**, an **optimizer plan
  panel** surfaces this greenhouse's latest optimizer cycle — the proposed-vs-current
  setpoint diff, the cycle outcome and [reason code](../optimizer/10-spec-optimizer-interfaces.md#escalation-reason-codes),
  the plan's confidence and explanation, and the backend that produced it — with the
  operator actions from the [optimizer console](#6-optimizer-operator-console-3).
- **Primary actions:** open the setpoint editor (view 3, its own route); change the
  historical time range; *(2a, simulation-only)* adjust the controller's
  **simulation speed** (0.5×/1×/2×/4×/8×) as a **live** control; jump to this
  greenhouse's filtered activity feed; (2b) view/assign the crop profile.
- **Role:** Viewer (read) / Operator (edits, speed).

### 3. Control — setpoint edits *(2a relay → sticky in 2b)*

- **Purpose:** the operator's manual control surface for one greenhouse. This is a
  **focused task on its own route** (`/greenhouses/:id/setpoints`,
  [architecture §3](./03-spec-frontend-architecture.md#3-route-tree)), reached from
  the detail view — a deliberate full-surface edit rather than a card scrolled past
  on the detail page. The editor reads the same cached greenhouse snapshot, so the
  focused route costs no telemetry context.
- **Shows:** the editable setpoint fields (mirroring the controller's
  runtime-adjustable [`[setpoints]`](../platform/03-spec-platform-data-model.md)) —
  the global climate targets **plus** the per-zone irrigation thresholds/schedule —
  current values, and the pending/confirmed state of an in-flight edit.
- **Primary actions:** submit a setpoint change. In 2a this is a thin relay to the
  controller's REST API; in 2b the same edit becomes a **sticky** part of the
  greenhouse's intended state and follows reconciliation
  ([platform fleet management](../platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control)).
  **Actuator-level forcing is not offered** — it stays a controller-local action
  ([platform constraints](../platform/11-spec-platform-constraints.md#7-scope--deferred--out-of-scope)).
- **Role:** Operator only (2b).

### 4. Crop-profile management *(2b)*

- **Purpose:** manage the library that turns "lettuce, fruiting" into setpoints.
- **Shows:** the crop-profile library (named, stage-aware target bundles) and,
  per greenhouse, its current profile + growth-stage assignment.
- **Primary actions:** browse/edit profiles; assign a profile + stage to a
  greenhouse and apply it (triggering platform resolution + reconciliation,
  [platform crop profiles](../platform/05-spec-platform-crop-profiles.md)).
- **Role:** Operator only.

### 5. Health & activity surfacing *(2a; drift in 2b)*

- **Purpose:** never let a problem go unseen.
- **Shows:** faults, offline controllers, and interlock activations raised
  prominently across fleet and detail views; an activity/audit feed of downward
  writes (who/what/when, [platform fleet management](../platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control)),
  **filterable by greenhouse and kind**. **Drift** (intended vs reported setpoints)
  is surfaced once reconciliation exists (2b).
- **Primary actions:** acknowledge/inspect; jump to the affected greenhouse. The
  reverse path exists too — the detail view links into the **greenhouse-filtered**
  feed (`/activity?greenhouse_id=…`, a deep-linkable query param) so an operator can
  drill from one greenhouse into its full history.
- **Role:** Viewer (read).

### 6. Optimizer operator console *(3)*

- **Purpose:** review and operate the Phase 3 optimizer — the LLM planner that refines
  setpoints on a fixed cadence — without leaving the dashboard or opening a second tool.
- **Shows:** a **fleet plan/escalation queue** — per greenhouse, its latest optimizer
  cycle outcome (`applied` / `escalated` / `extended`) and, for held cycles, the
  [reason code](../optimizer/10-spec-optimizer-interfaces.md#escalation-reason-codes) and
  age — plus site rollups (open-escalation **backlog**, counts by outcome, oldest open
  age). Drilling into one greenhouse's plan opens the **optimizer plan panel** on that
  greenhouse's [detail view](#2-per-greenhouse-detail-2a) (hybrid split — the queue is a
  console of its own, the plan detail lives with the greenhouse): the proposed-vs-current
  **setpoint diff** against crop-safe bounds, the plan's confidence and explanation, and
  the backend that produced it (provider / model / prompt version). The active **model**
  and the **enabled / read-only** state are shown too, alongside a **service-health badge** —
  the optimizer's overall status (healthy / degraded / unavailable) and, when degraded, the
  reason; the last-successful-cycle time against the expected cadence; and, when paused, the
  read-only reason ([optimizer interfaces](../optimizer/10-spec-optimizer-interfaces.md#the-operator-dashboard-reaches-this-surface-through-the-platform-go-api)).
- **Primary actions:** *(operator)* resolve an open escalation; trigger an **on-demand**
  planning cycle for one greenhouse; switch the active **model** within the allowlist;
  **pause / resume** planning (read-only mode). All relay through the Go API's
  [optimizer operator API](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory);
  the optimizer re-validates and still applies only through the platform write path.
- **Role:** Viewer (read — queue, plans, diff, state) / Operator (the actions above).

---

## What it is **not**

These belong elsewhere and are out of scope for the dashboard — see
[`09-spec-frontend-constraints.md`](./09-spec-frontend-constraints.md):

- **Not the controller's UI.** It edits *targets*, never forces actuators; safety
  interlocks stay [controller-owned](../controller/06-spec-controller-safety-and-constraints.md#2-safety-interlocks).
- **Not a zone-topology editor.** Adding/removing zones is a controller config +
  restart change ([P1 §4](../controller/07-spec-controller-config-and-parameters.md)),
  not in the platform's write path, so not in the UI.
- **Not platform observability.** Prometheus/Grafana cover *platform* health
  ([platform observability](../platform/08-spec-platform-operations.md#1-observability)); this dashboard
  is about *greenhouse* climate.
- **Not multi-site.** It manages a single site.

---

## Cross-references

- Capabilities & slicing: [platform dashboard](../platform/06-spec-platform-dashboard.md)
- The components that render these views: [`06-spec-frontend-components.md`](./06-spec-frontend-components.md)
- The data behind each view: [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md)
- Routing between views: [`03-spec-frontend-architecture.md`](./03-spec-frontend-architecture.md#3-route-tree)
- Optimizer operator surface the console fronts (view 6): [optimizer interfaces](../optimizer/10-spec-optimizer-interfaces.md#service-api-endpoints)
- Usability targets `P2-USE-1` / `P2-TEST-2`: [NFR doc](../../artifacts/non-functional-requirements.md)
