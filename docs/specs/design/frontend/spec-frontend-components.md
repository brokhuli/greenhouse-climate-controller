# Frontend — Components

> **Purpose:** The component inventory for the dashboard, derived from the views in
> [`spec-frontend-purpose-and-views.md`](./spec-frontend-purpose-and-views.md) and
> the structure in [`spec-frontend-architecture.md`](./spec-frontend-architecture.md).
> Grouped outermost (shell) inward (primitives). Each entry covers **purpose**,
> **props**, **data dependency** (which query/subscription it reads), **interaction**,
> **states** (loading / empty / error / offline), **a11y**, and **role-gating** (2b)
> where relevant. Visual values come from [`design-tokens.md`](./design-tokens.md);
> behavior from [`spec-frontend-interactions.md`](./spec-frontend-interactions.md).

Composition follows the one-way rule from
[architecture §7](./spec-frontend-architecture.md#7-component-composition-rules):
`app → features → components`. Primitives know nothing about the API; features own
data access; the shell owns chrome.

---

## 1. App shell (chrome)

### `AppFrame`

- **Purpose:** Root layout — persistent nav, header, content outlet, toast host.
- **Props:** none (reads route + session context).
- **Data:** none directly; renders the router outlet.
- **States:** always present; it is the surface that *survives* any view-level
  error or network failure ([architecture §9](./spec-frontend-architecture.md#9-failure-modes--recovery)).
- **a11y:** landmark regions (`<nav>`, `<main>`, `<header>`); skip-to-content link.

### `SideNav`

- **Purpose:** Primary navigation: Fleet, Activity, Profiles (2b).
- **Props:** active route.
- **Interaction:** client-side route links; collapses to a top bar + drawer below
  the mobile breakpoint ([interactions](./spec-frontend-interactions.md)).
- **a11y:** `<nav aria-label="Primary">`; `aria-current="page"` on the active item.

### `TopBar`

- **Purpose:** Header strip — current scope (site / greenhouse name),
  `ConnectionStatus`, theme toggle, and (2b) the signed-in identity + role.
- **Role-gating (2b):** shows the user menu / sign-out; viewer vs operator badge.

### `ConnectionStatus`

- **Purpose:** Live indicator of the WebSocket health (the single most important
  trust signal on a real-time dashboard).
- **Props:** `state: "live" | "reconnecting" | "polling" | "offline"`.
- **Data:** subscribes to the `ws.ts` connection state.
- **Interaction:** on hover/click, a small popover explains the state and last
  update time; behavior detailed in [interactions](./spec-frontend-interactions.md).
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
[`spec-frontend-purpose-and-views.md`](./spec-frontend-purpose-and-views.md) and a
route in [architecture §3](./spec-frontend-architecture.md#3-route-tree).

### `FleetOverview` *(2a)*

- **Purpose:** The landing view — every greenhouse at a glance + a site rollup.
- **Data:** `useFleet()` (`["fleet"]`), patched live by `status`/`drift` frames.
- **Renders:** a `FleetSummaryBar` (status rollup derivation) + a grid of
  `GreenhouseCard`.
- **States:** loading → `Skeleton` grid; empty → `EmptyState` ("no greenhouses
  registered" + register CTA); error → `ErrorState` with retry; per-card offline
  handled by `GreenhouseCard`.
- **Role-gating (2b):** register/retire actions operator-only.

### `GreenhouseCard` *(2a)*

- **Purpose:** One greenhouse in the fleet grid.
- **Props:** a `greenhouseSummary`.
- **Renders:** name, crop, `StatusBadge`, a compact reading-vs-setpoint `MetricTile`
  (or two), drift badge (2b).
- **Interaction:** whole card links to `/greenhouses/:id`.
- **States:** offline → muted styling + "offline" badge, last-known values dimmed.

### `GreenhouseDetail` *(2a)*

- **Purpose:** Deep view of one greenhouse.
- **Data:** `useGreenhouse(id)` (snapshot + current setpoints), `useTelemetryRange(id, range)`
  (history), and a live subscription for the streaming edge.
- **Renders:** header (`StatusBadge`, crop, profile chip in 2b); a stack of
  `TimeSeriesChart` (readings vs setpoint bands); `ActuatorStatePanel`; `EventList`;
  the `SetpointEditForm` entry point; a `RangePicker`.
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
  triggers platform resolution/reconciliation ([platform §5](../spec-climate-platform.md#5-crop-profiles--setpoint-resolution)).
- **States:** dirty/unsaved guard; save pending/confirmed/failed.

### `ActivityFeed` *(2a; drift entries 2b)*

- **Purpose:** Chronological events across the site — faults, interlocks, setpoint
  edits, profile applications, drift.
- **Data:** `useEvents(scope)` (`["events", scope]`), prepended by `event` frames.
- **Renders:** severity-grouped `EventList`; filter by greenhouse/kind.
- **States:** loading/empty/error standard; critical events also raise a toast.

---

## 3. Primitives (components)

Reused across views; typed props; zero domain knowledge.

### `Card`

- **Purpose:** The bordered, rounded container that defines the dashboard look.
- **Props:** `title?`, `actions?`, `variant?`.

### `StatusBadge`

- **Purpose:** Connectivity/health pill: online / degraded / offline / drift.
- **Props:** `status`, `drift?`.
- **a11y:** text label + icon, **never color-only** (WCAG; see
  [constraints](./spec-frontend-constraints.md)).

### `MetricTile` (reading-vs-setpoint)

- **Purpose:** One climate metric: current value, its setpoint, and the delta.
- **Props:** `label`, `value`, `setpoint`, `unit`, `state` (in-band / warn / fault).
- **Data:** uses the reading-vs-setpoint derivation
  ([data-model §8](./spec-frontend-data-model.md#8-view-model-derivations)).

### `TimeSeriesChart`

- **Purpose:** The live + historical line chart — the workhorse of the detail view.
- **Props:** `series: Series[]`, `bands?` (threshold shading), `range`.
- **Data:** historical from the Query cache + live from the ring buffer, merged by
  the series-merge derivation; renders via **uPlot**
  ([tech-stack](./spec-frontend-tech-stack.md)).
- **Behavior:** appends live points without re-query; cadence ≥ 1 Hz (`P2-USE-1`);
  reduced-motion disables transitions. Detailed in
  [interactions](./spec-frontend-interactions.md).
- **States:** loading → skeleton; empty → "no data in range"; live gap rendered
  explicitly on offline/reconnect.
- **a11y:** chart has an accessible summary + an optional data table fallback.

### `ActuatorStatePanel`

- **Purpose:** Commanded vs observed actuator positions.
- **Props:** `actuatorState[]`.

### `SetpointEditForm` *(2a)*

- **Purpose:** The operator's manual setpoint edit (view 3 in purpose-and-views).
- **Props:** `greenhouseId`, current `setpoints`.
- **Data:** `react-hook-form` + the `setpoints` schema; submit → setpoint mutation
  (2a relay; sticky/reconciled in 2b).
- **Interaction:** validate against crop-safe ranges; **confirmation dialog** before
  submit; optimistic pending → confirmed/failed ([interactions](./spec-frontend-interactions.md)).
  **No actuator forcing** — setpoints only ([constraints](./spec-frontend-constraints.md)).
- **Role-gating (2b):** operator-only; rendered disabled with a tooltip for viewers.

### `RangePicker`

- **Purpose:** Choose the historical window for the detail charts.
- **Props:** `value`, `onChange` (writes the `range` query param).

### `Button`, `Pill`, `Table`, `Dialog`, `Skeleton`, `EmptyState`, `ErrorState`, `Toast`

- **Purpose:** Standard primitives. `Button` variants (primary/secondary/danger);
  `Dialog` for confirmations; `Skeleton`/`EmptyState`/`ErrorState` are the canonical
  loading/empty/error renderings every view container reuses (so the states from
  [architecture §9](./spec-frontend-architecture.md#9-failure-modes--recovery) look
  consistent).
- **a11y:** `Dialog` traps focus, `Esc` closes; `Button` renders `<a>` vs `<button>`
  correctly; disabled write buttons keep an accessible reason.

### `ErrorBoundary`

- **Purpose:** Wraps each route so a render error degrades to an error card without
  taking down the shell or sibling routes.

---

## 4. Component → view map

| View / route | Components |
|---|---|
| `/` Fleet overview | `FleetOverview` → `FleetSummaryBar`, `GreenhouseCard` → `StatusBadge`, `MetricTile` |
| `/greenhouses/:id` Detail | `GreenhouseDetail` → `TimeSeriesChart`, `MetricTile`, `ActuatorStatePanel`, `EventList`, `SetpointEditForm`, `RangePicker` |
| `/profiles` (2b) | `ProfileLibrary` → profile cards, assignment panel |
| `/profiles/:id` (2b) | `ProfileEditor` → `SetpointFields`, stage selector |
| `/activity` | `ActivityFeed` → `EventList` |
| Persistent (chrome) | `AppFrame`, `SideNav`, `TopBar`, `ConnectionStatus`, `ToastHost` |

---

## 5. Performance notes

Per `P2-USE-1` (load < 2 s; charts ≥ 1 Hz):

- **Route-level code splitting** — each feature is a lazy module; the fleet view's
  initial bundle excludes the profile editor and the chart-heavy detail view.
- **uPlot for live charts** — canvas redraw of a moving window avoids per-point DOM
  churn ([tech-stack](./spec-frontend-tech-stack.md)).
- **Memoize chart inputs** — the series-merge derivation is memoized so a status
  frame for greenhouse B doesn't re-render greenhouse A's chart.
- **WS patches over refetch** — live frames patch the cache in place; the fleet
  grid re-renders only the changed card.
