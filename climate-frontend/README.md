# Frontend (Phase 2 dashboard)

Platform dashboard — **React 18 + TypeScript + Vite**.

The operator's single pane of glass over a site of greenhouses: live + historical telemetry,
fleet health, and setpoint control. It is a pure client of the platform Go API — **REST** for
request/response and a single **WebSocket** (`/api/stream`) for live push — and never speaks MQTT
or the controllers directly. Built as static assets and served by the platform's nginx in the full
stack. Specs: [`docs/specs/design/frontend/`](../docs/specs/design/frontend/); wire contracts:
[`contracts/frontend-rest/`](../contracts/frontend-rest/), [`contracts/frontend-ws/`](../contracts/frontend-ws/).

## Status — scaffold (2a, in progress)

This package is the **project skeleton plus the contract-bound API layer**. Built and green:

- App shell + theming: Vite, Tailwind v4 + design tokens (dark default / light), the route tree
  (`/`, `/greenhouses/:id`, `/activity`, 404) with a themed console shell (`AppFrame`/`SideNav`/`TopBar`).
- `src/api/` — the only module that knows the API exists: Zod wire schemas + camelCase adapters
  (`schemas.ts`), the fetch client with typed error mapping (`client.ts`), the WebSocket client with
  backoff reconnect + frame dispatch (`ws.ts`), and TanStack Query hooks (`queries/`).
- `src/lib/` — pure view-model derivations (reading-vs-setpoint, status rollup, range-tier).
- Tests: the Zod layer is checked against the committed contract fixtures; adapters, client, ws, and
  derivations are unit-tested; an `App` smoke test renders the shell.

**Deferred to later slices:** the real feature views (fleet grid, detail charts), uPlot charts,
setpoint/registration forms, optimistic mutation patching, Playwright + Lighthouse, the nginx
`proxy`/`frontend` compose services and the `Dockerfile`, and all 2b (crop profiles, drift UI,
Keycloak/OIDC).

## Layout

- `src/app/` — bootstrap, providers (QueryClient + theme + router), route tree.
- `src/api/` — `schemas.ts`, `client.ts`, `ws.ts`, `queries/`.
- `src/components/` — domain-agnostic primitives + the console shell.
- `src/features/` — one folder per view (placeholders for now).
- `src/hooks/`, `src/lib/`, `src/styles/` — theme, derivations, design tokens.
- `tests/unit/` — Vitest + React Testing Library; `tests/e2e/` is reserved for Playwright.

## Development

```sh
cd climate-frontend
npm install

npm run dev          # Vite dev server (proxies /api + /api/stream to the Go API on :8080)
npm run build        # tsc --noEmit + vite build → dist/
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit (strict)
npm run test         # Vitest (unit + component)
npm run format       # Prettier
```

Node version is pinned in [`.nvmrc`](./.nvmrc).

### Talking to the backend

The API base is empty by default (same-origin `/api`) — correct in dev (Vite proxy) and prod
(nginx). Override with `VITE_API_BASE` when running the SPA against a non-proxied API. To exercise
the data layer end to end, bring up the stack per [`../deploy/README.md`](../deploy/README.md) and
run `npm run dev`.
