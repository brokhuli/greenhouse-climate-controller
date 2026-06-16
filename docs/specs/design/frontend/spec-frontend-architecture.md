# Frontend — Architecture

> **Purpose:** Describe how the dashboard SPA is structured at the system level —
> system boundaries, directory layout, route tree, the **runtime data-flow graph**
> (REST + WebSocket), client-state topology, build/deploy pipeline, component
> composition rules, theming architecture, and failure modes. Sits one level above
> [`spec-frontend-components.md`](./spec-frontend-components.md) (per-component) and
> one level below [`spec-frontend-tech-stack.md`](./spec-frontend-tech-stack.md)
> (per-dependency). Read this to understand *how the pieces connect*.

> **Scope note.** The platform-level topology (services behind the proxy) is owned
> by [platform architecture](../platform/spec-platform-architecture.md) and
> [reverse proxy](../platform/spec-platform-architecture.md#4-reverse-proxy--the-edge); the API surface by
> [platform API surface](../platform/spec-platform-api-surface.md). This file describes the
> **client** that consumes them. Concrete library choices are in
> [`spec-frontend-tech-stack.md`](./spec-frontend-tech-stack.md).

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
                │ HTTP (/api, /auth)              │ WS (/api/ws)
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
([platform ingestion](../platform/spec-platform-ingestion.md),
[interfaces](../platform/spec-platform-interfaces.md)). This
boundary is load-bearing and is restated as a hard rule in
[`spec-frontend-constraints.md`](./spec-frontend-constraints.md).

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
│   │   └── activity/           ← ActivityFeed, health surfacing
│   ├── components/             ← reusable primitives (Card, StatusBadge, …)
│   ├── hooks/                  ← cross-feature hooks (useLiveSeries, useRole)
│   ├── lib/                    ← pure helpers (formatting, derivations, time)
│   ├── types/                  ← shared TS types (inferred from Zod where possible)
│   └── styles/
│       ├── tokens.css          ← CSS vars (per spec-frontend-design-tokens.md)
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
   per [`spec-frontend-data-model.md`](./spec-frontend-data-model.md).

---

## 3. Route tree

Client-side routes (React Router). nginx serves `index.html` for any unmatched
path so deep links resolve (SPA fallback,
[platform reverse proxy](../platform/spec-platform-architecture.md#4-reverse-proxy--the-edge)).

| Route | View | Slice | Notes |
|---|---|---|---|
| `/` | Fleet overview | 2a | Landing; fleet-of-one renders the same |
| `/greenhouses/:id` | Per-greenhouse detail | 2a | Live charts + history + setpoint edit |
| `/greenhouses/:id?range=…` | (same) | 2a | History range as a query param (deep-linkable) |
| `/profiles` | Crop-profile library | 2b | Operator-gated edits |
| `/profiles/:profileId` | Profile editor | 2b | Stage-aware target bundle |
| `/activity` | Activity / health feed | 2a | Drift entries appear in 2b |
| `/auth/callback` | OIDC redirect handler | 2b | Consumes Keycloak code, then redirects |
| `*` | 404 | 2a | On-brand not-found |

Write **actions** (setpoint edit, profile assign/apply) are not separate routes —
they are in-view affordances (dialog/inline form) on the detail and profile
views, so an operator never loses telemetry context to act.

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
   the [query-key scheme](./spec-frontend-data-model.md).
2. **WS carries the live edge.** A single WebSocket (`src/api/ws.ts`) subscribes
   to the greenhouses currently in view; incoming telemetry frames append to a
   per-series **ring buffer** sized to the visible window, which the chart renders
   without re-querying.
3. **Live patches the cache.** Status-change, drift, and event frames update the
   relevant Query cache entries directly (so the fleet view re-renders), rather
   than triggering a refetch — keeping fan-out within `P2-PERF-2` (< 1 s) and the
   chart cadence at `P2-USE-1` (≥ 1 Hz).

### Historical + live merge

A detail chart shows one continuous series: the **historical** portion comes from
a REST range query (the Query cache), the **live** portion from the WS ring
buffer. The chart concatenates `[…history, …liveBuffer]` and de-duplicates on
timestamp at the seam. When the user changes the range, only the historical query
re-runs; the live buffer is untouched.

### WebSocket lifecycle

- **Subscribe on view focus.** Detail view subscribes to its one greenhouse;
  fleet view subscribes to status/event streams for all (the API decides
  granularity — see [data-model WS taxonomy](./spec-frontend-data-model.md)).
- **Reconnect with backoff.** On drop, reconnect with exponential backoff (cap a
  few seconds); the connection state drives the `ConnectionStatus` indicator
  ([interactions](./spec-frontend-interactions.md)).
- **Backfill on reconnect.** After a gap, re-run the relevant range query to fill
  what the socket missed, then resume appending — no silent holes.
- **Polling fallback.** If the socket cannot be established, fall back to periodic
  REST polling at a reduced cadence and surface "degraded live updates."

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
[tech-stack](./spec-frontend-tech-stack.md). The query-key scheme that makes this
work is owned by [`spec-frontend-data-model.md`](./spec-frontend-data-model.md).

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
([platform deployment](../platform/spec-platform-operations.md#2-deployment)). The SPA is **static
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
live-update cadence (≥ 1 Hz) over the WebSocket stream.

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

Full inventory in [`spec-frontend-components.md`](./spec-frontend-components.md).

---

## 8. Theming architecture

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
swap. Token definitions are owned by [`spec-frontend-design-tokens.md`](./spec-frontend-design-tokens.md).

---

## 9. Failure modes & recovery

Unlike a static site, most failures here are **runtime and network-shaped**. What
can go wrong, how it's caught, and how the UI behaves:

| Failure | Detected by | UI behavior / recovery |
|---|---|---|
| WebSocket drops | `ws.ts` close/error | `ConnectionStatus` → "reconnecting"; backoff reconnect; backfill range query on resume ([§4](#4-runtime-data-flow)) |
| WebSocket never connects | connect timeout | Fall back to REST polling at reduced cadence; banner "live updates degraded" |
| Controller offline | API status / WS status frame | Greenhouse marked **offline** in fleet + detail; charts show last-known + a gap; edits disabled with reason |
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
| Why each dependency exists | referenced | [`spec-frontend-tech-stack.md`](./spec-frontend-tech-stack.md) |
| Data shapes, query keys, WS taxonomy | referenced | [`spec-frontend-data-model.md`](./spec-frontend-data-model.md) |
| Per-component contracts | referenced | [`spec-frontend-components.md`](./spec-frontend-components.md) |
| Visual tokens & theming values | referenced | [`spec-frontend-design-tokens.md`](./spec-frontend-design-tokens.md) |
| Behavior, motion, real-time UX | referenced | [`spec-frontend-interactions.md`](./spec-frontend-interactions.md) |
| Hard rules (hosting, auth, safety, perf) | constrained by | [`spec-frontend-constraints.md`](./spec-frontend-constraints.md) |
| Views being connected | composed from | [`spec-frontend-purpose-and-views.md`](./spec-frontend-purpose-and-views.md) |
| Platform topology & API surface | consumes | [platform architecture](../platform/spec-platform-architecture.md), [API surface](../platform/spec-platform-api-surface.md) |
