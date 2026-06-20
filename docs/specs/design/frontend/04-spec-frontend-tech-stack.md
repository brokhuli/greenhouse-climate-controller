# Frontend — Tech Stack

> **Purpose:** The recommended frontend dependency set, going one level deeper than
> [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only),
> which fixes only the load-bearing choices. Each entry states **what** it is,
> **why** it's chosen over alternatives, and **how** it's used here. Choices are constrained by the
> [NFR doc](../../artifacts/non-functional-requirements.md) (`P2-USE-1` load < 2 s
> + source-cadence live updates, ≥ 1 Hz at 1×; `P2-PERF-2` WS lag < 1 s; `P2-PERF-3` API p95 < 200 ms;
> `P2-TEST-2` Playwright + Lighthouse) and the
> [constraints](./09-spec-frontend-constraints.md) (Docker/nginx, API-only, 2a/2b).

> **High-stakes picks are flagged ⚑** — the charting library and the styling
> approach are the two choices most worth a second look before locking; each lists
> its alternatives and the trip-wire that would change the decision.

---

## Core framework

### React 18 + TypeScript — `react`, `react-dom`, `typescript`

- **What:** Component UI library + strict typing.
- **Why:** Fixed by [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only).
  TypeScript strict pays off because the API responses are validated and typed end
  to end (see [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md)).
- **How:** Function components + hooks only. `tsconfig` in `strict` mode; CI fails
  on type errors.

### Vite — `vite`, `@vitejs/plugin-react`

- **What:** Dev server (HMR) + production bundler.
- **Why:** Fast dev loop; first-class React + TS; trivial static output for nginx;
  built-in route-level code splitting. No SSR is needed — the SPA is served as
  static assets behind the proxy ([architecture §6](./03-spec-frontend-architecture.md#6-build--deploy-pipeline)).
- **How:** `output` is a static `dist/`. Dev proxies `/api` + `/auth` to the local
  Go API. `vite-plugin-checker` runs `tsc` in the build.

---

## Routing

### React Router — `react-router-dom`

- **What:** Client-side router.
- **Why:** The dashboard has a small, stable route set
  ([architecture §3](./03-spec-frontend-architecture.md#3-route-tree)); React Router
  is the conventional, well-supported choice and supports lazy route modules for
  code splitting.
- **How:** Route table in `src/app/routes.tsx`; views are lazy-loaded. nginx
  serves `index.html` for unmatched paths so deep links resolve.

---

## Data layer

### TanStack Query — `@tanstack/react-query`

- **What:** Async server-state cache (fetching, caching, invalidation, retries).
- **Why:** The dashboard is read-heavy over a live backend; Query gives caching,
  background refetch, staleness, and bounded retry for free, and is the natural
  home for the cache that WS frames patch
  ([architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow)). It
  removes the need for a hand-rolled fetch/cache layer or a Redux data slice.
- **How:** One `QueryClient` in `providers.tsx`. All REST access is via query/
  mutation hooks in `src/api/queries/`. The query-key scheme is owned by
  [`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md). Mutations
  (setpoint edit, profile assign) invalidate or optimistically patch the relevant
  keys.

### Native WebSocket client (no library) — `src/api/ws.ts`

- **What:** A thin wrapper over the browser `WebSocket`: subscribe, dispatch
  parsed frames, reconnect with backoff, backfill on resume.
- **Why:** The live channel is a single socket with a small message taxonomy
  ([data-model](./05-spec-frontend-data-model.md)); a dependency (socket.io etc.)
  would add weight and a server-side counterpart the Go API doesn't speak. ~100
  lines of vanilla TS covers it.
- **How:** One socket for the app; frames are Zod-parsed, then either appended to a
  per-series ring buffer (telemetry) or merged into the Query cache (status/drift/
  event). Connection state drives `ConnectionStatus`.

### State management — local first; **Zustand reserved as fallback**

- **What:** UI state is local (`useState`/`useReducer`); **Zustand** is adopted
  *only if* a piece of UI state must be shared across distant components.
- **Why:** Server state lives in Query; live data in ring-buffer hooks
  ([architecture §5](./03-spec-frontend-architecture.md#5-client-state-topology)).
  That leaves little global UI state. Starting without a store keeps the bundle and
  the mental model small; Zustand (~1 KB) is the escape hatch — mirroring the
  portfolio's "Preact as fallback" discipline.
- **How:** Don't add it until a concrete need appears. If added, one small store
  per concern, never a god-store.

---

## Charting ⚑

### uPlot — `uplot`

- **What:** A tiny (~40 KB), fast **canvas** time-series chart library.
- **Why:** The detail view streams multiple series at source cadence (`P2-USE-1`: **≥ 1 Hz** at
  1×, faster during fast-forward, intentionally slower below 1×) across a fleet that can reach
  **50 controllers** (`P2-SCAL-1`). Canvas rendering redraws a moving window without the per-point
  DOM/GC churn that SVG chart libs incur, holding the live cadence on a mid-tier machine. uPlot is purpose-built for
  exactly this (dense, live time series) and is small.
- **How:** Wrapped once in a `TimeSeriesChart` primitive
  ([components](./06-spec-frontend-components.md)) that takes a `series` array and
  reads colors from chart tokens ([design-tokens §chart](./07-spec-frontend-design-tokens.md)). The
  live ring buffer feeds it directly.
- **⚑ Alternatives & trip-wire:** **Recharts** (ergonomic, but SVG — drops frames
  with many live points), **ECharts** (capable but ~1 MB, heavier than the whole
  rest of the bundle), **visx** (flexible but more wiring, still SVG/React-render
  per point). Revisit only if a required chart type (e.g. complex annotations)
  proves impractical in uPlot — at which point reach for visx for that one chart,
  not a wholesale swap.

---

## Styling ⚑

### Tailwind CSS v4 + CSS-variable tokens — `tailwindcss`, `@tailwindcss/vite`

- **What:** Utility-first CSS, with the design tokens declared as CSS custom
  properties Tailwind reads.
- **Why:** The dashboard is a dense, card-and-table UI with many small spacing/
  border variants — utilities scale better than per-component stylesheets. CSS
  variables make the dark/light swap a one-attribute change
  ([architecture §8](./03-spec-frontend-architecture.md#8-theming-architecture)).
- **How:** Tokens in `src/styles/tokens.css` (owned by
  [`07-spec-frontend-design-tokens.md`](./07-spec-frontend-design-tokens.md)); Tailwind theme reads `var(--…)`;
  components write semantic utility classes, never raw hex.
- **⚑ Alternative:** **CSS Modules** (more isolation, more boilerplate) or a
  component kit like **shadcn/ui** (faster to assemble, but ships opinionated
  visuals to override). Tailwind + tokens keeps theming centralized and the
  dependency surface minimal; revisit if the team prefers a prebuilt component kit.

### Icons — `lucide-react`

- **What:** Tree-shakeable SVG icon set.
- **Why:** One consistent icon family for nav, status, and actions; only used icons
  are bundled. Matches the icon discipline used elsewhere in the repo's specs.
- **How:** Imported per-icon; sized via tokens.

---

## Forms & validation

### react-hook-form + Zod — `react-hook-form`, `zod`, `@hookform/resolvers`

- **What:** Form state/validation + schema validation.
- **Why:** The dashboard has *real* forms (setpoint edit, profile editor) unlike a
  static site. react-hook-form keeps re-renders minimal; **Zod** validates both
  form input *and* API responses, so one schema serves both the form and the
  data-model layer ([`05-spec-frontend-data-model.md`](./05-spec-frontend-data-model.md)).
- **How:** Zod schemas in `src/api/schemas.ts` are reused as form resolvers.
  Setpoint inputs validate against crop-safe ranges surfaced by the API; submit is
  blocked until valid.

---

## Authentication (2b)

### react-oidc-context / oidc-client-ts — `react-oidc-context`, `oidc-client-ts`

- **What:** OIDC relying-party client for the browser (Authorization Code + PKCE).
- **Why:** 2b delegates identity to **Keycloak**
  ([platform authentication](../platform/07-spec-platform-security.md),
  `P2-SEC-1`); the SPA only needs to perform the login redirect, hold tokens, and
  expose the role. These libraries do exactly that with no custom crypto.
- **How:** `AuthProvider` wraps the app; `/auth/callback` consumes the code; the
  access token is attached by `api/client.ts`; `useRole()` drives write-action
  gating. **In 2a this is absent** — the SPA runs unauthenticated on the trusted
  Docker network ([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).

---

## Testing

### Vitest + React Testing Library — `vitest`, `@testing-library/react`, `@testing-library/user-event`

- **What:** Unit/component test runner + DOM testing utilities.
- **Why:** Vitest shares Vite's transform pipeline (fast, same config); RTL tests
  components by behavior. Covers derivations (`lib/`), query hooks (with a mocked
  client), and component states (loading/empty/error/offline).
- **How:** `*.test.ts(x)` colocated; run in CI before the build.

### Playwright — `@playwright/test`

- **What:** End-to-end browser tests, including the **live-update latency**
  assertion.
- **Why:** `P2-TEST-2` mandates Playwright for E2E flows *and* the source-cadence
  live-update half of `P2-USE-1` (including ≥ 1 Hz at 1×), run against the **production build**.
- **How:** Specs in `tests/e2e/`: core flows (load fleet, open greenhouse, edit a
  setpoint) plus a test that drives a stream and asserts chart update cadence.

### Lighthouse CI — `@lhci/cli`

- **What:** Automated Lighthouse runs in CI.
- **Why:** `P2-TEST-2` mandates Lighthouse for the initial-load (< 2 s, `P2-USE-1`)
  and accessibility halves, against the production build.
- **How:** Runs after `vite build` in CI; thresholds in `.lighthouserc.json`;
  regressions fail the build.

---

## Tooling

- **ESLint** (`eslint`, `@typescript-eslint/*`, `eslint-plugin-react-hooks`) —
  style + hooks rules; runs in CI.
- **Prettier** — formatter; canonical class/prop ordering so diffs stay meaningful.
- **Node version pinned** (`.nvmrc`) for reproducible builds.

---

## Explicitly rejected

Recorded so the choice isn't re-litigated:

- **Next.js / Remix** — SSR/server runtime is pointless behind a static nginx
  mount on a local Docker network; adds a Node server the deployment model
  ([platform deployment](../platform/08-spec-platform-operations.md#2-deployment)) doesn't want.
- **Redux Toolkit** — server state belongs in Query; the residual UI state doesn't
  justify a global store and its boilerplate. Zustand is the fallback if needed.
- **socket.io** — needs a matching server; the Go API speaks plain WebSockets.
- **Chart.js / raw D3 / ECharts as default** — Chart.js/D3 are heavier per live
  point than uPlot; ECharts is ~1 MB. (visx kept in reserve for a one-off complex
  chart only.)
- **Material UI / Ant Design** — large, visually opinionated; fighting their theme
  costs more than composing primitives over tokens.
- **A WebSocket/state framework combo (e.g. RTK Query + socket middleware)** — more
  machinery than the small message taxonomy needs.
