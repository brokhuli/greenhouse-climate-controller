# Frontend — Components

> **Purpose:** The component inventory for the dashboard, derived from the views in
> [`02-spec-frontend-purpose-and-views.md`](./02-spec-frontend-purpose-and-views.md) and
> the structure in [`03-spec-frontend-architecture.md`](./03-spec-frontend-architecture.md).
> Grouped outermost (shell) inward (primitives). Each entry covers **purpose**,
> **props**, **data dependency** (which query/subscription it reads), **interaction**,
> **states** (loading / empty / error / offline), **a11y**, and **role-gating** (2b)
> where relevant. Visual values come from [`07-spec-frontend-design-tokens.md`](./07-spec-frontend-design-tokens.md);
> behavior from [`08-spec-frontend-interactions.md`](./08-spec-frontend-interactions.md).

Composition follows the one-way rule from
[architecture §7](./03-spec-frontend-architecture.md#7-component-composition-rules):
`app → features → components`. Primitives know nothing about the API; features own
data access; the shell owns chrome.

---

## 1. App shell (chrome)

### `AppFrame`

- **Purpose:** Root layout — persistent nav, header, content outlet, toast host.
- **Props:** none (reads route + session context).
- **Data:** none directly; renders the router outlet.
- **Visual:** desktop uses a two-column operations-console shell: fixed
  `SideNav` (`--layout-sidenav-width`) and a scrolling main canvas with
  `--layout-gutter` padding. Main content fills the available width; it is not
  centered in a marketing-page max-width container.
- **States:** always present; it is the surface that *survives* any view-level
  error or network failure ([architecture §9](./03-spec-frontend-architecture.md#9-failure-modes--recovery)).
- **a11y:** landmark regions (`<nav>`, `<main>`, `<header>`); skip-to-content link.

### `SideNav`

- **Purpose:** Primary navigation: Fleet, Activity, Optimizer (3), Profiles (2b).
- **Props:** active route.
- **Interaction:** client-side route links; collapses to a top bar + drawer below
  the mobile breakpoint ([interactions](./08-spec-frontend-interactions.md)). The
  active nav item renders with a rounded-rectangle background fill
  (`--color-surface-3`) to distinguish it from inactive items without relying on
  color alone.
- **Visual:** the rail uses `--color-shell`, quiet dividers, 20-24 px internal
  padding, and icon+label rows at `--size-control-md`. Active nav items invert
  strongly in light mode and use a warm raised surface in dark mode; inactive
  items stay flat.
- **a11y:** `<nav aria-label="Primary">`; `aria-current="page"` on the active item.

### `TopBar`

- **Purpose:** Header strip — current scope (site / greenhouse name),
  `ConnectionStatus`, theme toggle, and (2b) the signed-in identity + role.
- **Visual:** page title group sits left; live status, alert bell, and identity
  controls sit right. Controls use `--color-surface-raised`, `--radius-lg`, and
  fixed control heights from the token spec so timestamps and badges never resize
  the header.
- **Role-gating (2b):** shows the user menu / sign-out; viewer vs operator badge.

### `ConnectionStatus`

- **Purpose:** Live indicator of the WebSocket health (the single most important
  trust signal on a real-time dashboard).
- **Props:** `state: "live" | "reconnecting" | "polling" | "offline"`.
- **Data:** subscribes to the `ws.ts` connection state.
- **Interaction:** on hover/click, a small popover explains the state and last
  update time; behavior detailed in [interactions](./08-spec-frontend-interactions.md).
- **a11y:** `role="status"`, `aria-live="polite"`; not color-only (icon + label).

### `ToastHost`

- **Purpose:** Renders transient notifications (write confirmations, fault/drift
  alerts, errors).
- **Data:** a small toast queue (local/Zustand-fallback).
- **a11y:** `aria-live="assertive"` for critical, `"polite"` otherwise; toasts are
  dismissible and never the *only* place a fault is recorded (also in the feed).

---

## 2. View containers (features)

Each maps to a view in
[`02-spec-frontend-purpose-and-views.md`](./02-spec-frontend-purpose-and-views.md) and a
route in [architecture §3](./03-spec-frontend-architecture.md#3-route-tree).

### `FleetOverview` *(2a)*

- **Purpose:** The landing view — every greenhouse at a glance + a site rollup.
- **Data:** `useFleet()` (`["fleet"]`), patched live by `status`/`drift` frames.
- **Renders:** a `FleetSummaryBar` (status rollup derivation) + a grid of
  `GreenhouseCard`. A **Register** CTA in the view toolbar opens
  `RegisterGreenhouseDialog`. When any greenhouse is simulated, a `FleetTimeScaleControl` in the
  view toolbar sets the speed for the whole fleet at once (fan-out of independent
  per-controller writes — [interactions §7](./08-spec-frontend-interactions.md#7-writes--setpoint-edits--profile-apply)).
- **States:** loading → `Skeleton` grid; empty → `EmptyState` ("no greenhouses
  registered") whose CTA opens the same `RegisterGreenhouseDialog`; error → `ErrorState`
  with retry; per-card offline handled by `GreenhouseCard`.
- **Role-gating (2b):** register/retire actions operator-only (the toolbar/empty-state CTA
  renders disabled with a reason for viewers).

### `GreenhouseCard` *(2a)*

- **Purpose:** One greenhouse in the fleet grid.
- **Props:** a `greenhouseSummary`.
- **Renders:** name, crop, `StatusBadge`, a compact reading-vs-setpoint `MetricTile`
  (or two), drift badge (2b), and a `TimeScaleIndicator` speed badge when the greenhouse
  reports a non-1× `timeScale` (sim-only).
- **Interaction:** whole card links to `/greenhouses/:id`.
- **Visual:** fixed card anatomy: status row, title/crop row, metric pair, then a
  compact sparkline. Cards keep a stable min-height so online/offline states do
  not reshape the fleet grid. Offline/no-data cards show a muted empty state in
  the metric area, not a different card layout.
- **States:** offline → muted styling + "offline" badge, last-known values dimmed.

### `FleetSummaryBar` *(2a)*

- **Purpose:** Site-level rollup cards: total greenhouses, healthy, attention
  needed, offline, drift.
- **Props:** status-rollup view model.
- **Visual:** a responsive row/grid of summary cards with large tabular numbers,
  short captions, and optional compact sparklines/icons. The cards use the same
  `Card` shell and should fit five across on wide desktop before wrapping.

### `GreenhouseDetail` *(2a)*

- **Purpose:** Deep view of one greenhouse.
- **Data:** `useGreenhouse(id)` (snapshot + current setpoints), `useTelemetryRange(id, range)`
  (history), and a live subscription for the streaming edge.
- **Renders:** header (`StatusBadge`, crop, profile chip in 2b, a `RetireGreenhouseAction`
  in the header overflow, and — on a simulated controller — a `TimeScaleControl` live speed knob +
  `TimeScaleIndicator`); a `GreenhouseSummaryBar` of `MetricTile`s (including the active
  **Day / Night** temperature setpoint, [data-model §8](./05-spec-frontend-data-model.md#8-view-model-derivations)); a stack of
  `TimeSeriesChart` (readings vs setpoint bands, plotted on simulated time); `ActuatorStatePanel`;
  a `ZoneMoisturePanel` (live per-zone irrigation status); a **Recent Activity** card
  (`EventList`) that links to this greenhouse's filtered [`ActivityFeed`](#activityfeed-2a-drift-entries-2b);
  *(3)* an [`OptimizerPlanPanel`](#optimizerplanpanel-3) showing the latest optimizer cycle + setpoint diff;
  a **link/button to the `/greenhouses/:id/setpoints` route** (the `SetpointEditForm` lives on
  that route, not inline — [architecture §3](./03-spec-frontend-architecture.md#3-route-tree)); a `RangePicker`.
- **States:** loading → skeleton charts; offline → charts show history + a live gap
  + "controller offline"; error → error card, cached snapshot stays.
- **Role-gating (2b):** edit/assign affordances operator-only (rendered disabled
  with reason for viewers).

### `ProfileLibrary` *(2b)*

- **Purpose:** Browse the crop-profile library; see per-greenhouse assignments.
- **Data:** `useProfiles()`.
- **Renders:** list/grid of profiles; an assignment panel per greenhouse.
- **Role-gating:** create/edit/assign operator-only.

### `ProfileEditor` *(2b)*

- **Purpose:** Edit a profile's stage-aware target bundles.
- **Data:** `useProfile(id)`; `react-hook-form` + the `setpoints` Zod schema.
- **Renders:** a stage selector and a `SetpointFields` group per stage.
- **Interaction:** validate against crop-safe ranges; save → mutation; assign+apply
  triggers platform resolution/reconciliation ([platform crop profiles](../platform/05-spec-platform-crop-profiles.md)).
- **States:** dirty/unsaved guard; save pending/confirmed/failed.

### `ActivityFeed` *(2a; drift entries 2b)*

- **Purpose:** Chronological events across the site — faults, interlocks, setpoint
  edits, profile applications, drift.
- **Data:** `useEvents(scope)` (`["events", scope]`), prepended by `event` frames. The
  `scope` (`greenhouseId` / `kind` / `severity`) is hydrated from the URL query params, so
  `/activity?greenhouse_id=…` deep-links a pre-filtered feed (the detail view's Recent
  Activity card links here).
- **Renders:** severity-grouped `EventList`; a greenhouse/kind filter control bound to
  the query params.
- **States:** loading/empty/error standard; critical events also raise a toast.

### `OptimizerConsole` *(3)*

- **Purpose:** The `/optimizer` view — the fleet plan/escalation queue and the site rollup
  (view 6 in purpose-and-views). The **plan detail** is not here; it is the
  `OptimizerPlanPanel` on the greenhouse detail view (hybrid split).
- **Data:** `useOptimizerFleet()` (`["optimizer-fleet"]`) + `useOptimizerEscalations()`
  (`["optimizer-escalations"]`) + `useOptimizerModel()` / `useOptimizerEnabled()`, all **polled**
  ([data-model §6](./05-spec-frontend-data-model.md#6-query-keys--cache-strategy)); no live subscription.
- **Renders:** an `OptimizerRollupBar` (backlog, counts-by-outcome, oldest-open age from the
  fleet rollup); an `EscalationQueue` of `EscalationRow`s (each with a `ReasonCodeChip`,
  `PlanOutcomeBadge`, a link to the greenhouse's plan panel, and a **Resolve** action); a global
  `OptimizerEnableToggle` (pause/resume) and `ModelSelector` in the view toolbar. The queue filter
  (`greenhouse_id` / `status`) is bound to the URL query params.
- **States:** loading → skeletons; empty → `EmptyState` ("no open escalations — all cycles applied
  or extended"); error → `ErrorState` with retry; a read-only banner when the optimizer is disabled.
- **Role-gating (2b):** the queue/rollup/state are viewer-readable; every action (Resolve, trigger,
  model switch, pause/resume) is operator-only (rendered disabled with a reason for viewers).

### `OptimizerPlanPanel` *(3)*

- **Purpose:** One greenhouse's latest optimizer cycle, rendered as a panel **on the detail view**
  (`/greenhouses/:id`) — the per-greenhouse half of the hybrid split.
- **Data:** `useOptimizerPlan(id)` (`["optimizer-plan", id]`, polled) — the flattened plan plus the
  Go-API-composed setpoint diff.
- **Renders:** a `PlanOutcomeBadge` (+ `ReasonCodeChip` when escalated), the plan's `confidence` and
  `explanation`, the `backend` provenance (provider / model / prompt version / role), a `SetpointDiff`
  (proposed vs current vs bounds), and — for this greenhouse — a `TriggerCycleAction` and, when the
  cycle is escalated, a **Resolve** action.
- **States:** loading → skeleton; empty → "no optimizer plan yet" (cold start / pre-first-cycle);
  a **held-cycle** record (plan `null`) shows the outcome + reason with no diff ("cycle ran; nothing
  applied"). Absent entirely on a real deployment without the optimizer.
- **Role-gating (2b):** read for viewers; trigger/resolve operator-only.

---

## 3. Primitives (components)

Reused across views; typed props; zero domain knowledge.

### `Card`

- **Purpose:** The bordered, rounded container that defines the dashboard look.
- **Props:** `title?`, `actions?`, `variant?`.
- **Visual:** cards are flat, bordered panels (`--color-surface-1`,
  `--color-border`, `--radius-lg`) with 16-20 px internal padding. They do not
  nest inside other cards. Hoverable cards change border color and surface tone
  subtly; ordinary dashboard cards do not use visible drop shadows.

### `PanelHeader`

- **Purpose:** Shared header row for cards/panels with title, optional value, and
  compact actions.
- **Visual:** title uses `--text-sm` or `--text-md` depending on density; section
  labels use the token spec's `section-label` pattern. Actions stay right-aligned
  in fixed-height controls so toolbar changes do not move chart content.

### `StatusBadge`

- **Purpose:** Connectivity/health pill: online / degraded / offline / drift.
- **Props:** `status`, `drift?`.
- **a11y:** text label + icon, **never color-only** (WCAG; see
  [constraints](./09-spec-frontend-constraints.md)).

### `MetricTile` (reading-vs-setpoint)

- **Purpose:** One climate metric: current value, its setpoint, and the delta.
- **Props:** `label`, `value`, `setpoint`, `unit`, `state` (in-band / warn / fault).
- **Data:** uses the reading-vs-setpoint derivation
  ([data-model §8](./05-spec-frontend-data-model.md#8-view-model-derivations)).

### `TimeSeriesChart`

- **Purpose:** The live + historical line chart — the workhorse of the detail view.
- **Props:** `series: Series[]`, `bands?` (threshold shading), `range`.
- **Variants:** **Full** (axes, bands, legend — used in `GreenhouseDetail`) and
  **Compact/Sparkline** (no axes, no legend, single series — used in fleet header
  stat cards and `GreenhouseCard`). The compact variant inherits
  `--chart-stroke-width` and metric-specific chart tokens but renders no grid or
  band shading.
- **Visual:** full charts use a bordered plot area, subtle grid, tabular axis
  labels, solid metric lines, dashed setpoint/min-max references, and low-opacity
  area fills. Compact sparklines sit at `--chart-sparkline-height`, preserve the
  same metric color, and never show axes or legends.
- **Data:** historical from the Query cache + live from the ring buffer, merged by
  the series-merge derivation; renders via **uPlot**
  ([tech-stack](./04-spec-frontend-tech-stack.md)).
- **Behavior:** appends live points without re-query; cadence follows the source stream
  (`P2-USE-1`: ≥ 1 Hz at 1×, intentionally slower below 1×), and reduced-motion disables
  transitions. The x-axis is **simulated time** (keyed on each frame's `ts`), so under an
  accelerated simulation the window scrolls faster in wall-clock while staying internally
  consistent; the renderer coalesces the higher arrival rate. Detailed in
  [interactions §4](./08-spec-frontend-interactions.md#4-live-chart-updates-the-core-real-time-behavior).
- **States:** loading → skeleton; empty → "no data in range"; live gap rendered
  explicitly on offline/reconnect.
- **a11y:** chart has an accessible summary + an optional data table fallback.

### `ActuatorStatePanel`

- **Purpose:** Commanded vs observed actuator positions.
- **Props:** `actuatorState[]`.

### `ZoneMoisturePanel` *(2a)*

- **Purpose:** Live per-zone irrigation status on the detail view — the read-only
  counterpart to the per-zone irrigation *targets* the operator edits on the setpoints
  route.
- **Props:** `zones` — one row per zone, each merging the mutable targets
  (`moistureLowThreshold` / `moistureHighThreshold` / `schedule`) with the live
  `zoneStatus` (`soilMoistureVwc`, `irrigating`, `faulted`, `lastCycleTs` —
  [data-model §3](./05-spec-frontend-data-model.md#3-relational-shapes-config--metadata)).
- **Data:** the feature merges `useGreenhouse(id)`'s `zoneStatus` with the live
  per-zone `soil_moisture` edge (`useLiveSeries`, keyed by `zone_id`) and passes rows
  down; the panel itself is presentational.
- **Renders:** per zone — a band-colored moisture **gauge** (dry / target / wet regions
  split at the thresholds), a headline status pill (**Watering** / **Dry** / **Saturated**
  / **OK** / **Fault** / **No data**), the last-watered label, and the schedule. Uses the
  zone-status derivations ([data-model §8](./05-spec-frontend-data-model.md#8-view-model-derivations)).
- **States:** faulted zone → reading shown as "—" (never a stale value) + Fault pill;
  no reading → "No data".
- **a11y:** status travels with a text label, **never color-only**.

### `SetpointEditForm` *(2a)*

- **Purpose:** The operator's manual setpoint edit (view 3 in purpose-and-views). Rendered
  on its **own route** (`/greenhouses/:id/setpoints`) via the `SetpointsView` feature
  wrapper — reached from the detail view, not embedded in it
  ([architecture §3](./03-spec-frontend-architecture.md#3-route-tree)).
- **Props:** `greenhouseId`, current `setpoints`.
- **Data:** `react-hook-form` + the `setpoints` schema; submit → setpoint mutation
  (2a relay; sticky/reconciled in 2b).
- **Interaction:** validate against crop-safe ranges; **confirmation dialog** before
  submit; optimistic pending → confirmed/failed ([interactions](./08-spec-frontend-interactions.md)).
  **No actuator forcing** — setpoints only ([constraints](./09-spec-frontend-constraints.md)).
- **Offline:** when the controller is offline, **2a** disables the form ("edits unavailable
  until it reconnects" — the relay can't reach it) while **2b** keeps it enabled and queues
  the edit as intended state, applied on reconnect ([interactions §6](./08-spec-frontend-interactions.md#6-controller-offline-vs-platformsocket-offline)).
- **Role-gating (2b):** operator-only; rendered disabled with a tooltip for viewers.

### `RangePicker`

- **Purpose:** Choose the historical window for the detail charts.
- **Props:** `value`, `onChange` (writes the `range` query param).

### `RegisterGreenhouseDialog` *(2a)*

- **Purpose:** Add a greenhouse to the fleet (view 1 register action) — a lightweight, contextual
  write, so a modal form rather than its own route ([architecture §3](./03-spec-frontend-architecture.md#3-route-tree);
  the focused setpoint edit is the one write that does get a route).
- **Props:** `open`, `onClose`.
- **Data:** `react-hook-form` + the `greenhouseRegistration` Zod schema
  ([data-model §3](./05-spec-frontend-data-model.md#3-relational-shapes-config--metadata)); submit →
  register mutation (`POST /api/greenhouses`).
- **Interaction:** validate the slug/display-name/controller-endpoint fields; submit → optimistic
  pending; **422** maps to inline field errors (the API names the violated field); success invalidates
  `["fleet"]`, toasts, and closes ([interactions §7](./08-spec-frontend-interactions.md#7-writes--setpoint-edits--profile-apply)).
- **States:** idle / submitting / field-error; dirty-guard on close.
- **Role-gating (2b):** operator-only.

### `RetireGreenhouseAction` *(2a)*

- **Purpose:** Remove a greenhouse from the fleet (view 1 retire action) — a `danger` confirm
  `Dialog`, summarizing what is removed (registry entry only; history is retained).
- **Props:** `greenhouseId`, `displayName`.
- **Data:** retire mutation (`DELETE /api/greenhouses/:id`).
- **Interaction:** explicit confirm → on success invalidate `["fleet"]`, drop `["greenhouse", id]`,
  toast, and navigate to `/`; on failure, error toast, no removal.
- **Role-gating (2b):** operator-only.

### `TimeScaleControl` / `TimeScaleIndicator` *(2a, simulation-only)*

- **Purpose:** `TimeScaleControl` is the **live** simulation-speed knob (the per-greenhouse one on
  the detail header; `FleetTimeScaleControl` is the same control wired to the fleet fan-out).
  `TimeScaleIndicator` is the read-only speed badge shown on cards / headers.
- **Props:** `TimeScaleControl` — `greenhouseId?` (omitted = fleet), current `scale`, `onChange`;
  `TimeScaleIndicator` — `scale`.
- **Data:** reads `greenhouseSummary.timeScale` (kept live by the `status` frame); the control's
  `onChange` fires `PATCH .../sim/time-scale` (or the fleet path).
- **Interaction:** a segmented 0.5×/1×/2×/4×/8× operator control. The platform/controller API still
  accepts the full 0.25–32× range for direct/headless use, including 16×/32×, but those speeds are
  intentionally not offered in the frontend because live rendering can become choppy. It writes
  **immediately** — no confirmation dialog — with optimistic-pending + rollback
  ([interactions §7](./08-spec-frontend-interactions.md#7-writes--setpoint-edits--profile-apply)).
- **States:** hidden/disabled when the greenhouse reports no `timeScale` (real hardware); pending
  while a write is in flight; per-greenhouse failure surfaced on the fleet variant.
- **a11y:** a labeled group (radio semantics for the segmented form); not color-only.
- **Visual:** uses `--size-control-sm`/`-md` like the other segmented controls/pills.

### Optimizer primitives *(3)*

Presentational pieces the `OptimizerConsole` and `OptimizerPlanPanel` compose; typed props, no data
access. **No `GateTraceStepper`** — the plan exposes a final `outcome` + `explanation`, not a
step-by-step gate trace ([data-model](./05-spec-frontend-data-model.md#optimizer-plans--escalations-3)),
so a decision-trace panel is deliberately out of v1.

- **`OptimizerRollupBar`** — site rollup cards (backlog, counts by outcome, oldest-open age) from the
  fleet summary; same `Card` shell as `FleetSummaryBar`, with a text label per number (never color-only).
- **`EscalationQueue` / `EscalationRow`** — the open-escalation table; rows ordered persistent-before-transient
  ([data-model §8](./05-spec-frontend-data-model.md#8-view-model-derivations)). Each row: greenhouse,
  `ReasonCodeChip`, age, message, a link to the plan panel, and an operator **Resolve** action.
- **`PlanOutcomeBadge`** — the `applied` / `escalated` / `extended` status pill; text label + icon,
  **never color-only** ([constraints](./09-spec-frontend-constraints.md)).
- **`ReasonCodeChip`** — renders a `reason_code` + its `reason_class` (transient / persistent) from the
  [canonical table](../optimizer/10-spec-optimizer-interfaces.md#escalation-reason-codes); a tooltip
  carries the human description. Does **not** hardcode the code list — it maps whatever the API sends.
- **`SetpointDiff`** — a field-by-field table of **changed** setpoints (proposed vs current), each with
  direction and a near-bound flag against the crop-safe bounds; unchanged fields are collapsed. Props:
  `proposed`, `current`, `bounds` ([data-model](./05-spec-frontend-data-model.md#optimizer-plans--escalations-3)).
- **`ModelSelector`** — a segmented/select control over the active provider's `available_models`
  allowlist; `onChange` fires `POST …/model`. Shows the active `model` + `prompt_version`; the
  `provider` is read-only (an offline change). Operator-gated.
- **`OptimizerEnableToggle`** — pause/resume planning (`enabled` ↔ read-only); a `danger`-adjacent
  confirm on disable. Operator-gated; reflects the polled `EnableState`.
- **`TriggerCycleAction`** — run an on-demand cycle for one greenhouse (`POST …/cycles`, optional
  `reason`); disabled while the optimizer is off or a cycle is in flight (`409`). Operator-gated.

### `Button`, `Pill`, `Table`, `Dialog`, `Skeleton`, `EmptyState`, `ErrorState`, `Toast`

- **Purpose:** Standard primitives. `Button` variants (primary/secondary/danger);
  `Dialog` for confirmations; `Skeleton`/`EmptyState`/`ErrorState` are the canonical
  loading/empty/error renderings every view container reuses (so the states from
  [architecture §9](./03-spec-frontend-architecture.md#9-failure-modes--recovery) look
  consistent).
- **Visual:** controls are compact and utilitarian. Icon-only buttons use
  `--size-icon-button`; segmented controls and pills use `--size-control-sm` or
  `--size-control-md`; primary actions use the inverse/accent treatment from the
  token spec rather than oversized hero-style buttons. These are *visual* sizes; on
  coarse pointers each control's *hit area* expands to `--size-touch-target` (44px)
  without changing its rendered size ([tokens §5](./07-spec-frontend-design-tokens.md#5-spacing-radii-shadows)).
- **a11y:** `Dialog` traps focus, `Esc` closes; `Button` renders `<a>` vs `<button>`
  correctly; disabled write buttons keep an accessible reason.

### `ErrorBoundary`

- **Purpose:** Wraps each route so a render error degrades to an error card without
  taking down the shell or sibling routes.

---

## 4. Component → view map

| View / route | Components |
|---|---|
| `/` Fleet overview | `FleetOverview` → `FleetSummaryBar`, `RegisterGreenhouseDialog`, `FleetTimeScaleControl` (sim-only), `GreenhouseCard` → `StatusBadge`, `MetricTile`, `TimeScaleIndicator` (sim-only) |
| `/greenhouses/:id` Detail | `GreenhouseDetail` → `GreenhouseSummaryBar`/`MetricTile`, `TimeSeriesChart`, `ActuatorStatePanel`, `ZoneMoisturePanel`, `EventList` (Recent Activity), `OptimizerPlanPanel` (3) → `PlanOutcomeBadge`/`ReasonCodeChip`/`SetpointDiff`/`TriggerCycleAction`, `RetireGreenhouseAction`, `RangePicker`, `TimeScaleControl`/`TimeScaleIndicator` (sim-only) |
| `/greenhouses/:id/setpoints` Setpoint editor | `SetpointsView` → `SetpointEditForm` |
| `/profiles` (2b) | `ProfileLibrary` → profile cards, assignment panel |
| `/profiles/:id` (2b) | `ProfileEditor` → `SetpointFields`, stage selector |
| `/activity` | `ActivityFeed` → `EventList` |
| `/optimizer` (3) | `OptimizerConsole` → `OptimizerRollupBar`, `EscalationQueue`/`EscalationRow`, `ReasonCodeChip`, `PlanOutcomeBadge`, `ModelSelector`, `OptimizerEnableToggle` |
| Persistent (chrome) | `AppFrame`, `SideNav`, `TopBar`, `ConnectionStatus`, `ToastHost` |

---

## 5. Performance notes

Per `P2-USE-1` (load < 2 s; charts source-cadence, ≥ 1 Hz at 1×):

- **Route-level code splitting** — each feature is a lazy module; the fleet view's
  initial bundle excludes the profile editor and the chart-heavy detail view.
- **uPlot for live charts** — canvas redraw of a moving window avoids per-point DOM
  churn ([tech-stack](./04-spec-frontend-tech-stack.md)).
- **Memoize chart inputs** — the series-merge derivation is memoized so a status
  frame for greenhouse B doesn't re-render greenhouse A's chart.
- **WS patches over refetch** — live frames patch the cache in place; the fleet
  grid re-renders only the changed card.
