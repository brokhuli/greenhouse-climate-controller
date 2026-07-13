# Frontend — Constraints

> **Purpose:** The fixed boundaries the dashboard is built inside. These are not
> goals or preferences — quality goals live in the
> [NFR doc](../../artifacts/non-functional-requirements.md). Constraints are the
> **non-negotiable rules** imposed by the platform architecture, the system's safety
> model, the delivery slicing, and prior decisions (RFCs/ADRs). If a design choice
> conflicts with anything below, the design choice changes.

Each entry: the constraint, **why** it exists, and **what it forces or forbids**.
Most are inherited from the [platform spec](../platform/01-spec-platform-overview.md) and the
[RFCs](../../../decisions/request-for-comments.md); this file restates them in
frontend terms.

---

## Hosting & delivery

### Served as static assets by the platform's nginx — not a public static host

- **Why:** The platform is a local, containerized stack behind a
  [single nginx entry point](../platform/02-spec-platform-architecture.md#4-reverse-proxy--the-edge)
  ([RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress));
  the SPA is the `frontend` service's built assets
  ([platform deployment](../platform/08-spec-platform-operations.md#2-deployment)).
- **Forces:** A static `dist/` build (Vite); client-side routing with an
  `index.html` fallback configured in nginx; runtime config (API base) supplied by
  the deployment, not hardcoded.
- **Forbids:** SSR / a Node server at request time; assuming a CDN, custom domain,
  or apex-path hosting; build steps incompatible with the Docker image.

### Whole stack stands up with one `docker compose up`

- **Why:** `P2-PORT-1` — no cloud account, reproducible local bring-up.
- **Forces:** The frontend builds in CI/Docker with a pinned Node version; no
  install-time network dependencies beyond the registry.
- **Forbids:** Manual post-build steps; `latest`-tagged deps.

---

## Integration boundary

### The browser talks **only** to the Go API

- **Why:** MQTT and the controller REST API are platform-internal
  ([platform ingestion](../platform/04-spec-platform-ingestion.md),
  [interfaces](../platform/09-spec-platform-interfaces.md)); the
  SPA is a pure API client ([architecture §1](./03-spec-frontend-architecture.md#1-system-boundaries)).
- **Forces:** All *runtime* data access via `src/api/` (REST + the one WebSocket); the
  client holds no MQTT or controller knowledge **as a transport** — it never derives a
  controller address or topic to talk to one directly.
- **Forbids:** Connecting to the MQTT broker from the browser; calling a controller's
  REST API directly; using controller registry metadata as a runtime channel, or
  hardcoding a topic map / controller URL into the SPA.

> **Carve-out — registry metadata, not transport.** Collecting a controller's
> `rest_base_url` / `mqtt_topic_root` on the *registration* form and forwarding them to
> the Go API is allowed: that is registry metadata the **platform** consumes to reach the
> controller, never a channel the SPA speaks
> ([data-model §3](./05-spec-frontend-data-model.md#3-relational-shapes-config--metadata)).
> The rule is *may collect and forward, may not use as a runtime transport.*

### Binds to the API contract; never redefines wire formats

- **Why:** `contracts/` + [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
  are the single source of truth.
- **Forces:** Client schemas mirror the platform's shapes and validate at runtime
  ([data-model](./05-spec-frontend-data-model.md)); the client schemas validate
  against the authored Go-API↔SPA contract in `contracts/` (`platform-dashboard-rest/`,
  `platform-dashboard-live-ws/`).
- **Forbids:** Inventing payload shapes the API doesn't emit; silently tolerating a
  `schema_version` mismatch.

---

## Control & safety

### Setpoint-only control — never actuators

- **Why:** The platform's downward control is
  [setpoint-only](../platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control);
  manual actuator forcing is a
  [controller-local action](../controller/02-spec-controller-architecture.md#6-manual-override).
- **Forces:** Write UIs expose only setpoints / target bundles.
- **Forbids:** Any UI that commands an actuator directly or proxies an actuator
  override.
- **One narrow, explicit exception — the simulation-only time-scale knob.** The
  [`TimeScaleControl`](./06-spec-frontend-components.md) sets a *simulated* controller's clock
  speed (relayed through the platform's sim-only
  [`/sim/time-scale`](../controller/08-spec-controller-interfaces.md#simulation-control-simulated-hal-only)).
  It is a **diagnostic, not a setpoint and not an actuator command** — it never touches a control
  output — so it does not breach the setpoint-only rule; it is hidden/disabled on real-hardware
  greenhouses. This mirrors the platform-side exception in
  [platform constraints §7](../platform/11-spec-platform-constraints.md#7-scope--deferred--out-of-scope).

### Safety stays in the controller — the UI only observes it

- **Why:** Critical-temp and CO₂-ceiling
  [interlocks](../controller/06-spec-controller-safety-and-constraints.md#2-safety-interlocks) hold unconditional
  priority **inside** the controller
  ([platform fleet management](../platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control)).
- **Forces:** The dashboard *displays* interlock activations prominently and treats
  them as authoritative.
- **Forbids:** Any control that could override or silence a safety interlock.

### All writes go through the platform's single setpoint authority

- **Why:** The platform is the sole setpoint authority and delivery path
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
  [platform crop profiles](../platform/05-spec-platform-crop-profiles.md)).
- **Forces:** Setpoint edits and profile applies POST/PATCH to the platform API; the
  UI shows provenance/attribution.
- **Forbids:** Any client-side path that delivers setpoints to a controller bypassing
  the platform.

---

## Authentication & access (2b)

### 2a is unauthenticated; 2b is OIDC with two roles

- **Why:** 2a runs on the trusted local Docker network
  ([RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
  superseding [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries));
  2b delegates identity to Keycloak with viewer/operator roles
  ([platform authentication](../platform/07-spec-platform-security.md),
  `P2-SEC-1`).
- **Forces:** 2a ships no auth UI; 2b gates every write affordance to the operator
  role and performs the OIDC redirect flow.
- **Forbids:** The SPA handling credentials itself; inventing roles beyond
  viewer/operator; gating *reads* in 2b (viewers see everything read-only).

---

## Performance & real-time budget

### Load and live-update targets are hard

- **Why:** `P2-USE-1` (initial load < 2 s; live charts source-cadence, ≥ 1 Hz at 1×), `P2-PERF-2` (WS lag
  < 1 s), `P2-PERF-3` (API p95 < 200 ms) — and the dashboard *is the product*
  (Observability rated Critical for Phase 2).
- **Forces:** Route-level code splitting; canvas charting (uPlot); WS patches over
  refetch; memoized derivations ([components §5](./06-spec-frontend-components.md#5-performance-notes)).
- **Forbids:** Shipping a chart library that drops frames at fleet scale; re-querying
  on every live frame; blocking initial paint on non-critical data.

### Validated against the production build in CI

- **Why:** `P2-TEST-2` — Playwright (E2E + source-cadence live latency, including ≥ 1 Hz at 1×) and Lighthouse CI
  (load + a11y) run against the **production build**, not the dev server.
- **Forces:** A CI pipeline that builds then tests; thresholds that fail the build.
- **Forbids:** Asserting performance/a11y against the dev server.

---

## Accessibility & compatibility

### WCAG 2.1 AA is the floor

- **Why:** An operator console must be reliably readable, including under stress and
  on imperfect displays.
- **Forces:** Text contrast ≥ 4.5:1 in both themes; **status is never color-only**
  (icon + label); full keyboard reachability; visible focus; `prefers-reduced-motion`
  honored; charts have a text/table fallback.
- **Forbids:** Color as the sole signal for online/degraded/offline/drift/fault;
  hover-only affordances; motion that ignores reduced-motion.

### Modern evergreen browsers; responsive to operator screens

- **Why:** Operators use current Chrome/Firefox/Safari/Edge, sometimes on tablets.
- **Forces:** Layout reflows from wide control screens down to tablet; interactive
  **hit areas** ≥ 44 px on coarse pointers (the dense `--size-control-*` *visual* sizes are
  preserved — the tap target expands separately via `--size-touch-target`,
  [tokens §5](./07-spec-frontend-design-tokens.md#5-spacing-radii-shadows)); the sidenav
  collapses below `--bp-md`.
- **Forbids:** Desktop-only fixed layouts; features without ≥ 95% browser support and
  no graceful fallback.

---

## Scope — what the dashboard is **not**

Mirrors [platform constraints](../platform/11-spec-platform-constraints.md#7-scope--deferred--out-of-scope):

- **Not the controller UI** — no actuator forcing; safety stays controller-owned.
- **Not a zone-topology editor** — adding/removing zones is a controller config +
  restart change ([P1 §4](../controller/07-spec-controller-config-and-parameters.md)),
  outside the platform write path.
- **Not platform observability** — Prometheus/Grafana cover platform health
  ([platform observability](../platform/08-spec-platform-operations.md#1-observability)); this is greenhouse
  climate.
- **Not multi-site / multi-tenant** — a single site.
- **Not a second optimizer control path.** The Phase 3 **optimizer operator console**
  *is* part of the dashboard (review proposed/applied plans and the held-cycle escalation
  queue, see the proposed-vs-current setpoint diff, and resolve / trigger a cycle /
  switch model / pause-resume) — but it reaches the optimizer **only through the Go API**
  and only **observes and operates** it. The optimizer still refines setpoints solely
  through the platform's [single write path](../platform/05-spec-platform-crop-profiles.md),
  so the console adds no control path.
  - **Forces:** optimizer reads (plans, escalations, `fleet` rollup, model/enable state)
    and operator writes go through the platform's
    [optimizer operator API](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory);
    the console **surfaces** plans and [reason codes](../optimizer/10-spec-optimizer-interfaces.md#escalation-reason-codes)
    and gates its mutations to the operator role.
  - **Forbids:** the SPA calling the optimizer's FastAPI directly (a second origin —
    [it talks only to the Go API](#the-browser-talks-only-to-the-go-api)); any console
    affordance that applies a plan or setpoint outside the platform authority, commands a
    controller, or overrides an optimizer gate.

If a future capability crosses one of these lines, it belongs in the platform/
controller/optimizer specs first — not bolted onto the SPA.
