# Frontend — Architecture

> **Purpose:** Describe how the dashboard SPA is structured at the system level —
> system boundaries, directory layout, route tree, the **runtime data-flow graph**
> (REST + WebSocket), client-state topology, build/deploy pipeline, component
> composition rules, theming architecture, and failure modes. Sits one level above
> [`06-spec-frontend-components.md`](./06-spec-frontend-components.md) (per-component) and
> one level below [`04-spec-frontend-tech-stack.md`](./04-spec-frontend-tech-stack.md)
> (per-dependency). Read this to understand *how the pieces connect*.

> **Scope note.** The platform-level topology (services behind the proxy) is owned
> by [platform architecture](../platform/02-spec-platform-architecture.md) and
> [reverse proxy](../platform/02-spec-platform-architecture.md#4-reverse-proxy--the-edge); the API surface by
> [platform API surface](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory). This file describes the
> **client** that consumes them. Concrete library choices are in
> [`04-spec-frontend-tech-stack.md`](./04-spec-frontend-tech-stack.md).

---

## 1. System boundaries

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                       │
│                                                                │
│   React SPA (this spec set)                                    │
│    ├─ REST client  ── GET history, profiles; PATCH/POST edits  │
│    └─ WS client    ── live telemetry, status, drift, events    │
└───────────────┬───────────────────────────────┬──────────────┘
                │ HTTP (/api, /auth)              │ WS (/api/stream)
                ▼                                 ▼
        ┌───────────────────────────────────────────────┐
        │             Reverse proxy (nginx)              │
        │  serves built SPA assets; proxies /api (REST + │
        │  WS upgrade); /auth → Keycloak (2b)            │
        └───────────────────────┬───────────────────────┘
                                 │ /api
                        ┌────────▼─────────┐
                        │   Go API (Echo)  │  ── single setpoint authority
                        └────────┬─────────┘
                   ┌─────────────┴─────────────┐
                   ▼                           ▼
             TimescaleDB                MQTT broker / controllers
```

The SPA's **only** runtime dependency is the Go API (and, in 2b, Keycloak for the
login redirect). It has **no** knowledge of MQTT, TimescaleDB, or the controller
REST API — those are platform-internal
([platform ingestion](../platform/04-spec-platform-ingestion.md),
[interfaces](../platform/09-spec-platform-interfaces.md)). This
boundary is load-bearing and is restated as a hard rule in
[`09-spec-frontend-constraints.md`](./09-spec-frontend-constraints.md).

---

## 2. Directory layout

```
frontend/
├── public/                     ← copied verbatim into the build (favicon, etc.)
├── index.html                  ← Vite entry; single root <div id="root">
├── src/
│   ├── main.tsx                ← bootstraps React, Router, QueryClient, providers
│   ├── app/
│   │   ├── App.tsx             ← route tree + AppFrame shell
│   │   ├── providers.tsx       ← QueryClientProvider, ThemeProvider, AuthProvider (2b)
│   │   └── routes.tsx          ← route definitions (lazy-loaded view modules)
│   ├── api/                    ← the only place that knows the API exists
│   │   ├── client.ts           ← fetch wrapper (base URL, errors, auth header 2b)
│   │   ├── ws.ts               ← WebSocket client (subscribe, reconnect, dispatch)
│   │   ├── queries/            ← TanStack Query hooks (useFleet, useTelemetry, …)
│   │   └── schemas.ts          ← Zod schemas for responses + WS messages
│   ├── features/               ← one folder per view (purpose-and-views)
│   │   ├── fleet/              ← FleetOverview + its pieces
│   │   ├── greenhouse/         ← GreenhouseDetail, charts, setpoint edit
│   │   ├── profiles/           ← ProfileLibrary, ProfileEditor (2b)
│   │   ├── activity/           ← ActivityFeed, health surfacing
│   │   └── optimizer/          ← OptimizerConsole (fleet table + health) + OptimizerPlanPanel (3)
│   ├── components/             ← reusable primitives (Card, StatusBadge, …)
│   ├── hooks/                  ← cross-feature hooks (useLiveSeries, useRole)
│   ├── lib/                    ← pure helpers (formatting, derivations, time)
│   ├── types/                  ← shared TS types (inferred from Zod where possible)
│   └── styles/
│       ├── tokens.css          ← CSS vars (per 07-spec-frontend-design-tokens.md)
│       └── global.css          ← Tailwind entry + base
├── tests/
│   ├── unit/                   ← Vitest + React Testing Library
│   └── e2e/                    ← Playwright (P2-TEST-2)
├── Dockerfile                  ← multi-stage: build → nginx static image
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js
└── package.json
```

Three boundaries are load-bearing:

1. **`src/api/` is the only module that knows the API exists.** Features and
   components consume typed query/mutation hooks and never call `fetch` or open a
   socket directly. Swapping transport details touches one folder.
2. **`features/` is view-scoped; `components/` is domain-agnostic.** A primitive
   (`TimeSeriesChart`, `Card`) takes typed props and knows nothing about a
   greenhouse; a feature wires primitives to query hooks. See [§7](#7-component-composition-rules).
3. **Displayed values come from API data via the data-model spec.** Components do
   not invent shapes; response/WS shapes are defined once in `src/api/schemas.ts`
   per [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md).

---

## 3. Route tree

Client-side routes (React Router). nginx serves `index.html` for any unmatched
path so deep links resolve (SPA fallback,
[platform reverse proxy](../platform/02-spec-platform-architecture.md#4-reverse-proxy--the-edge)).

| Route | View | Slice | Notes |
|---|---|---|---|
| `/` | Fleet overview | 2a | Landing; fleet-of-one renders the same |
| `/greenhouses/:id` | Per-greenhouse detail | 2a | Live charts + history; links out to the setpoint editor |
| `/greenhouses/:id?range=…` | (same) | 2a | History range as a query param (deep-linkable) |
| `/greenhouses/:id/setpoints` | Setpoint editor | 2a | Focused manual-control surface for one greenhouse (`SetpointsView` → `SetpointEditForm`) |
| `/profiles` | Crop-profile library | 2b | Operator-gated edits |
| `/profiles/:profileId` | Profile editor | 2b | Stage-aware target bundle |
| `/activity` | Activity / health feed | 2a | Drift entries appear in 2b |
| `/activity?greenhouse_id=…&kind=…` | (same) | 2a | Greenhouse/kind filter as query params (deep-linkable; the detail view links here) |
| `/optimizer` | Optimizer operator console | 3 | Fleet optimizer table + service-health metrics (escalations are the `status=escalated` filter); plan **detail** is a panel on `/greenhouses/:id`, not a separate route (hybrid split) |
| `/optimizer?greenhouse_id=…&status=…` | (same) | 3 | Greenhouse/outcome filter as query params (deep-linkable) |
| `/login/callback` | OIDC redirect handler | 2b | Client-owned (not under `/auth`); consumes Keycloak code, then redirects |
| `*` | 404 | 2a | On-brand not-found |

Writes split by weight. A **focused** write — the setpoint edit — gets its **own
route** (`/greenhouses/:id/setpoints`) so the operator commits to it deliberately on
a surface built for that one task, rather than editing a bundle of fields wedged into
a card they scrolled past. **Lightweight/contextual** writes stay **in-view
affordances** (dialog/inline form) so the operator never loses telemetry context for
a quick action: register/retire are `Dialog`s on the fleet/detail views, and **(2b)**
profile assign/apply is an in-view affordance on the detail/profile views. The
detail → setpoints route keeps the greenhouse's live snapshot one click away (and the
editor reads the same cached snapshot), so the focused route costs no context.

---

## 4. Runtime data flow

This is the heart of the SPA and the biggest departure from a static site: data
is **live**, not built. Two channels feed every view, and they merge.

```
        ┌──────────────────────────────────────────────────────┐
        │                  TanStack Query cache                 │
        │   keyed server state: fleet, greenhouse, profiles,    │
        │   telemetry-range, events  (see data-model §query-keys)│
        └───────▲───────────────────────────────────▲──────────┘
                │ (1) REST: initial + range queries   │ (3) live patch
                │                                     │
        ┌───────┴────────┐                   ┌────────┴───────────┐
        │  REST client   │                   │   WS client (ws.ts)│
        │  (api/client)  │                   │  one socket, fan-in │
        └───────▲────────┘                   └────────▲───────────┘
                │ HTTP                                 │ WS frames
                └──────────────► Go API ◄─────────────┘
                                                       │
                                                       ▼
                                          ┌────────────────────────┐
                                          │  live chart ring-buffer │ (2)
                                          │  per greenhouse/series  │
                                          └────────────────────────┘
```

1. **REST seeds state.** On entering a view, query hooks fetch the current
   snapshot and any historical range. Results land in the Query cache, keyed per
   the [query-key scheme](./05-spec-frontend-data-model.md).
2. **WS carries the live edge.** A single WebSocket (`src/api/ws.ts`) subscribes
   to the greenhouses currently in view; incoming telemetry frames append to a
   per-series **ring buffer** sized to the visible window, which the chart renders
   without re-querying.
3. **Live patches the cache.** Status-change, drift, and event frames update the
   relevant Query cache entries directly (so the fleet view re-renders), rather
   than triggering a refetch — keeping fan-out within `P2-PERF-2` (< 1 s) and the
   chart cadence at `P2-USE-1` (source cadence; ≥ 1 Hz at 1×). On a simulated greenhouse the `status` frame
   also carries the optional `time_scale`, patched into `greenhouseSummary.timeScale`
   to drive the speed indicator.

### Historical + live merge

A detail chart shows one continuous series: the **historical** portion comes from
a REST range query (the Query cache), the **live** portion from the WS ring
buffer. The chart concatenates `[…history, …liveBuffer]` and de-duplicates on
timestamp at the seam — the **simulated-time `ts`**, so the seam is consistent
regardless of the controller's current speed. When the user changes the range, only
the historical query re-runs; the live buffer is untouched.

**Raw vs aggregates by range.** The historical portion is **raw telemetry** for short
ranges and time-bucketed **analytics aggregates**
([`/analytics`](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory), data-model
[§4](./05-spec-frontend-data-model.md#4-time-series-shapes-telemetry--events)) for long ones — a
pure [range-tier derivation](./05-spec-frontend-data-model.md#8-view-model-derivations) picks the
tier from the requested range (default switch **~24 h**, tunable) and, for aggregates, an `interval`
that keeps the bucket count bounded (target ~300–500 points). Either way the live WS ring buffer
(raw) still appends at the tail; the chart renders the historical tier then the live edge, seamed at
the latest bucket boundary. The query key reflects the tier
(`["telemetry", id, range]` vs `["analytics", id, range, interval]`), so changing range re-runs only
the relevant historical query.

### WebSocket lifecycle

- **Subscribe on view focus.** Detail view subscribes to its one greenhouse;
  fleet view subscribes to status/event streams for all (the API decides
  granularity — see [data-model WS taxonomy](./05-spec-frontend-data-model.md)).
- **Reconnect with backoff.** On drop, reconnect with exponential backoff (cap a
  few seconds); the connection state drives the `ConnectionStatus` indicator
  ([interactions](./08-spec-frontend-interactions.md)).
- **Backfill on reconnect.** After a gap, re-run the relevant range query to fill
  what the socket missed, then resume appending — no silent holes.
- **Polling fallback.** If the socket cannot be established, fall back to periodic
  REST polling at a reduced cadence and surface "degraded live updates" (detailed
  below).

### Polling fallback

When the WebSocket can't be established (connect timeout / repeated failures), the SPA
keeps the views live-ish over REST instead of going dark. `ConnectionStatus` shows
**polling** ([interactions §5](./08-spec-frontend-interactions.md#5-connection-status-reconnect--backfill)).

- **Cadence.** A fixed reduced interval — default **~10 s** (tunable), far below the live
  ≥ 1 Hz target — implemented as TanStack Query `refetchInterval` on the in-view queries.
  The interval is chosen to stay within `P2-PERF-3` (API p95 < 200 ms) at fleet scale.
- **Endpoints.** Reuses the existing REST GETs — fleet list (`["fleet"]`), greenhouse
  snapshot (`["greenhouse", id]`), and whichever chart query is in view: the telemetry range
  (`["telemetry", id, range]`) or, on a long range, the analytics aggregates
  (`["analytics", id, range, interval]`). No polling-only endpoints; the contract surface is unchanged.
- **Scope (fleet-scale).** Polls only what's **in view** — the fleet list + status on the
  overview, the single visible greenhouse on detail — never a per-greenhouse fan-out across
  the whole fleet. Background/unfocused queries don't poll.
- **Cache & buffer path.** Refetches land in the **Query cache**, the same path REST seeding
  and backfill already use ([§4](#4-runtime-data-flow)) — so no parallel code path. The
  telemetry range query advances the chart's *historical* portion while live ring-buffer
  appends are paused; the chart renders from the refreshed range. When the socket returns,
  normal WS appends resume after a backfill range query — **no silent holes**.

### Optimizer console — REST polling (no WebSocket)

The Phase 3 optimizer surface (`/optimizer` + the detail plan panel) is **REST-polled**, not
streamed. Optimizer cycles run on a fixed multi-hour cadence, so plan outcomes and the escalation
queue change on the order of minutes — nothing like the sub-second telemetry the WebSocket carries,
and not worth a new frame type or fan-out. The optimizer queries (`["optimizer-status"]`,
`["optimizer-fleet"]`, `["optimizer-escalations"]`, `["optimizer-plan", id]`, `["optimizer-model"]`,
`["optimizer-enabled"]`, `["optimizer-greenhouse-enabled", id]`) use a modest TanStack Query
`refetchInterval` ([data-model §6](./05-spec-frontend-data-model.md#6-query-keys--cache-strategy)) — the
**same** mechanism as the WS polling-fallback above, but here it is the **primary** update path, not a
degraded one. The **Fleet overview** route also polls `["optimizer-fleet"]` (the one rollup endpoint) to
paint each greenhouse card's optimizer pill — one shared query, no per-card fan-out — and a per-greenhouse
enable write (`POST …/greenhouses/:id/enabled`) invalidates `["optimizer-fleet"]` +
`["optimizer-greenhouse-enabled", id]` so the card, table, and detail panel reconcile together. No optimizer frame joins the WebSocket union. The optimizer signals that *do* ride the live
stream are the four `optimizer_*` **activity events** — `optimizer_plan_applied` (an applied plan is
a setpoint write stamped `source: optimizer`, so it flows through the existing `event` frame) plus the
escalation-lifecycle + run-failure audit events `optimizer_plan_escalated`, `optimizer_resolved`, and
`optimizer_run_failed` ([data-model §4](./05-spec-frontend-data-model.md#4-rest-payloads)). Those three
record *transitions* in the append-only activity feed; the *actionable* escalation **queue** — the set
of holds open right now — stays REST-polled here and remains authoritative for operator action. The feed
and the queue are complementary: the feed is the durable log of what happened, the queue is the live
worklist. (`optimizer_plan_extended` is not a feed kind — a suppressed cycle writes nothing and recurs on
most cadences, so it would be feed noise.)

---

## 5. Client-state topology

Two kinds of state, kept apart:

| State | Owner | Examples |
|---|---|---|
| **Server state** | TanStack Query cache | fleet, greenhouse snapshot, telemetry range, profiles, events |
| **Live edge** | per-series ring buffers (hooks) | the last N seconds of streaming readings for visible charts |
| **UI state** | local component state | open dialogs, selected range, form drafts, theme |
| **Session** (2b) | AuthProvider context | tokens, identity, role |

There is **no global app store by default.** Server state lives in Query; UI state
is local. A small store (Zustand) is the *reserved fallback* if a piece of UI
state genuinely needs to be shared across distant components — see
[tech-stack](./04-spec-frontend-tech-stack.md). The query-key scheme that makes this
work is owned by [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md).

---

## 6. Build & deploy pipeline

### Local dev

```
npm run dev
  └─ vite dev          ← HMR; proxies /api + /auth to the local Go API (vite.config.ts)
```

### Production build

```
npm run build
  └─ vite build        ← tsc typecheck (via vite-plugin-checker) → bundle → dist/
        ├─ route-level code splitting (lazy view modules)
        └─ Output: dist/  (static assets: HTML/CSS/JS, hashed)
```

### Container & serving

A multi-stage `Dockerfile` builds `dist/` then copies it into the `frontend`
nginx image that the platform's `proxy` serves
([platform deployment](../platform/08-spec-platform-operations.md#2-deployment)). The SPA is **static
assets**; there is no Node runtime at request time.

### CI

```
on: push / PR
  - npm ci
  - eslint .             ← style + import rules
  - tsc --noEmit         ← typecheck (also enforced by vite-plugin-checker in build)
  - vitest run           ← unit + component tests
  - vite build           ← reproduces the production bundle
  - playwright test      ← E2E + live-update latency (P2-TEST-2)
  - lighthouse-ci        ← initial-load perf + a11y vs the production build (P2-USE-1, P2-TEST-2)
```

`P2-USE-1`'s two halves are split across the last two steps exactly as the NFR
doc prescribes: Lighthouse gates initial-load (< 2 s); Playwright asserts the
live-update cadence (source cadence; ≥ 1 Hz at 1×, intentionally slower below 1×)
over the WebSocket stream.

---

## 7. Component composition rules

Three layers, one-way:

```
       app/ (shell + providers)   ◀── owns routing, providers, AppFrame
          │
          ▼
       features/ (views)          ◀── compose primitives + query hooks
          │
          ▼
       components/ (primitives)   ◀── typed props, zero domain knowledge
```

Rules:

1. **Primitives know nothing about the API.** `TimeSeriesChart` takes a `series`
   array, not a greenhouse; `StatusBadge` takes a `status` enum, not a fleet entry.
2. **Features own data access.** A feature calls its query/mutation hooks and maps
   results to primitive props; routes don't thread data through props.
3. **The shell owns chrome + providers.** `AppFrame`, nav, and the toast host live
   in `app/` and wrap features via the router outlet.
4. **One way only.** `components → (nothing)`, `features → components`,
   `app → features`. No cycles.

Full inventory in [`06-spec-frontend-components.md`](./06-spec-frontend-components.md).

---

## 8. Theming architecture

The visual system draws on the set of light- and dark-mode mockups in
`research/frontend mockups/` — reference material for styling, color, and layout
rather than pixel-exact specs. They depict a dense operator console, not a
landing page. Desktop layout is a fixed left
rail plus a scrolling content canvas; the main area fills the viewport and uses
responsive grids for rollups, greenhouse cards, charts, and side panels. Mobile
keeps the same information hierarchy but moves navigation into the top-bar
drawer defined by the breakpoint tokens.

```
src/styles/tokens.css
  ├─ :root                 ← theme-agnostic tokens (spacing, radii, motion)
  ├─ [data-theme="dark"]   ← dark palette (default)
  └─ [data-theme="light"]  ← light palette

Tailwind (CSS-first) reads var(--color-*) → utilities resolve per theme
```

An inline script in `index.html` sets `data-theme` from `localStorage` (or
`prefers-color-scheme`) before first paint to avoid a flash. Charts, status
colors, and surfaces all read the same tokens and re-theme with one attribute
swap. Token definitions are owned by [`07-spec-frontend-design-tokens.md`](./07-spec-frontend-design-tokens.md).

---

## 9. Failure modes & recovery

Unlike a static site, most failures here are **runtime and network-shaped**. What
can go wrong, how it's caught, and how the UI behaves:

| Failure | Detected by | UI behavior / recovery |
|---|---|---|
| WebSocket drops | `ws.ts` close/error | `ConnectionStatus` → "reconnecting"; backoff reconnect; backfill range query on resume ([§4](#4-runtime-data-flow)) |
| WebSocket never connects | connect timeout | Fall back to REST polling at reduced cadence; banner "live updates degraded" |
| Controller offline | API status / WS status frame | Greenhouse marked **offline** in fleet + detail; charts show last-known + a gap; **2a** edits disabled (relay can't reach it), **2b** edits stay enabled and are held as intended state, applied on reconnect ([interactions §6](./08-spec-frontend-interactions.md#6-controller-offline-vs-platformsocket-offline)) |
| Stale data | query staleness + WS silence | "data may be stale" affordance; auto-refetch on focus/reconnect |
| Setpoint drift (2b) | API drift signal | Drift badge in fleet/detail; activity entry; non-blocking |
| REST 4xx (validation) | `client.ts` | Inline form error from the API message; no retry |
| REST 401 / token expiry (2b) | `client.ts` | Silent token refresh; if it fails, redirect to login, preserving the route |
| REST 5xx / network error | `client.ts` + Query retry | Bounded retry with backoff; then an error state with a retry action; cached data stays visible |
| Response fails schema | Zod parse in `api/schemas.ts` | Dev: throw loudly. Prod: drop the bad record, log, render the rest (degrade, don't crash) |
| Render error in a view | React `ErrorBoundary` | Boundary around each route → error card with reload; the shell and other routes survive |
| Initial bundle fails to load | browser | Static `index.html` shows a minimal "failed to load" with reload (no framework needed) |

The guiding principle: **a transport problem degrades a view; it never blanks the
app.** Cached data and the shell stay on screen while the SPA recovers.

---

## 10. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Why each dependency exists | referenced | [`04-spec-frontend-tech-stack.md`](./04-spec-frontend-tech-stack.md) |
| Data shapes, query keys, WS taxonomy | referenced | [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md) |
| Per-component contracts | referenced | [`06-spec-frontend-components.md`](./06-spec-frontend-components.md) |
| Visual tokens & theming values | referenced | [`07-spec-frontend-design-tokens.md`](./07-spec-frontend-design-tokens.md) |
| Behavior, motion, real-time UX | referenced | [`08-spec-frontend-interactions.md`](./08-spec-frontend-interactions.md) |
| Hard rules (hosting, auth, safety, perf) | constrained by | [`09-spec-frontend-constraints.md`](./09-spec-frontend-constraints.md) |
| Views being connected | composed from | [`02-spec-frontend-purpose-and-views.md`](./02-spec-frontend-purpose-and-views.md) |
| Platform topology & API surface | consumes | [platform architecture](../platform/02-spec-platform-architecture.md), [API surface](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory) |
