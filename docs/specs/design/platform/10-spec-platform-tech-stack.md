# Platform — Tech Stack

> **Purpose:** The recommended platform dependency set, going one level deeper than
> [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only),
> which fixes only the load-bearing choices. Each entry states **what** it is,
> **why** it's chosen over alternatives, and **how** it's used here. Choices are
> constrained by the [NFR doc](../../artifacts/non-functional-requirements.md)
> (`P2-PERF-3` API p95 < 200 ms; `P2-SCAL-1` ~50 controllers; `P2-USE-1` ≥ 1 Hz live)
> and by the [constraints](./11-spec-platform-constraints.md) (local/no-cloud, setpoint-only
> downward, single authority).

> **High-stakes picks are flagged ⚑** — the database-access layer and the MQTT client
> are the two choices most worth a second look before locking; each lists its
> alternatives and the trip-wire that would change the decision.

---

## Core service

### Go + Echo — `echo`

- **What:** The API service language + HTTP framework.
- **Why:** Fixed by
  [tech-stack-decisions.md](../tech-stack-decisions.md#phase-2--local-paas-platform-docker-only).
  Go gives a single static binary, cheap concurrency for the ingest + WS fan-out
  workloads, and a small container. Echo is a thin router/middleware layer over
  `net/http` — enough structure (routing, middleware, binding) without a heavy
  framework.
- **How:** One `api` binary hosts every responsibility
  ([architecture — the hub](./02-spec-platform-architecture.md#2-the-go-api-is-the-hub)):
  REST handlers, the MQTT ingester goroutine, the WS hub, and the reconciliation loop.
  Middleware carries structured logging, recovery, and (2b) token validation.

---

## Persistence ⚑

### TimescaleDB (PostgreSQL extension)

- **What:** PostgreSQL with the time-series extension; one instance holds both the
  relational registry/profiles and the telemetry hypertables
  ([data model](./03-spec-platform-data-model.md)).
- **Why:** Fixed by
  [RFC-002](../../../decisions/request-for-comments.md#rfc-002-phase-2-persistence-layer).
  One datastore for both shapes avoids a second operational surface; hypertables +
  retention + continuous aggregates handle the append-only telemetry
  ([ingestion §5](./04-spec-platform-ingestion.md#5-retention--downsampling)).

### `pgx` + `sqlc`, `golang-migrate` ⚑

- **What:** `pgx` is the PostgreSQL driver; `sqlc` generates type-safe Go from SQL;
  `golang-migrate` applies versioned schema migrations.
- **Why:** Raw SQL with generated types keeps the queries explicit and fast and the
  Go layer type-checked, without an ORM's hidden query behavior — which matters for the
  range/aggregate queries behind the dashboard (`P2-PERF-3`). Migrations are versioned
  files so schema changes are reviewable and reproducible in the container.
- **How:** Queries live in `.sql` files compiled by `sqlc`; migrations run on `api`
  startup. The TimescaleDB-specific DDL (hypertables, policies) lives in migrations.
- **⚑ Alternatives & trip-wire:** **GORM / ent** (faster to scaffold, but obscure the
  generated SQL and fight TimescaleDB-specific features); **plain `database/sql`**
  (loses pgx's performance and Postgres type support). Revisit only if the query
  surface grows enough that hand-written SQL becomes the bottleneck rather than the
  schema.

---

## Messaging

### Eclipse Paho MQTT Go client — `paho.mqtt.golang` ⚑

- **What:** The MQTT client the ingester uses to subscribe to controller telemetry.
- **Why:** The de-facto Go MQTT client; handles reconnect, QoS, and retained messages —
  exactly the MQTT features ingestion relies on for liveness and current-state recovery
  ([ingestion §4](./04-spec-platform-ingestion.md#4-qos-retained--liveness)).
- **How:** One client wildcard-subscribes to `gh/+/...`
  ([ingestion §2](./04-spec-platform-ingestion.md#2-per-greenhouse-routing)); message
  handlers validate the envelope, route by `greenhouse_id`, and write to the store.
- **⚑ Alternatives & trip-wire:** **`autopaho` / paho.golang** (the newer v5 client —
  worth adopting if MQTT 5 features are needed) or **mochi-co/mqtt** (broker, not a
  client). Revisit if MQTT 5 features (shared subscriptions, message expiry) become
  required.

### Mosquitto (broker)

- **What:** The MQTT broker (infrastructure, not a Go dependency).
- **Why:** Fixed by
  [RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection);
  lightweight, ubiquitous, trivial to run as a container.
- **How:** A `mqtt` Compose service ([operations](./08-spec-platform-operations.md#2-deployment)).

---

## Real-time & web

### WebSocket fan-out — `coder/websocket` (or `gorilla/websocket`)

- **What:** The server side of the live channel that pushes telemetry/status/drift/events
  to the dashboard.
- **Why:** Echo proxies the upgrade; a thin, well-maintained WS library is all the hub
  needs. The frontend speaks plain WebSockets (no socket.io counterpart)
  ([frontend tech stack](../frontend/04-spec-frontend-tech-stack.md)).
- **How:** One hub goroutine multiplexes the broadcast to all connected clients; frames
  mirror the small taxonomy the [frontend data model](../frontend/05-spec-frontend-data-model.md)
  expects.

### nginx (reverse proxy)

- **What:** The single entry point (infrastructure).
- **Why:** Fixed by
  [RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress)
  — static, config-driven service map; nginx over Traefik
  ([architecture §4](./02-spec-platform-architecture.md#4-reverse-proxy--the-edge)).
- **How:** Serves the SPA `dist/` and proxies `/api` (+ WS upgrade) and, in 2b,
  `/auth`.

---

## Authentication (2b)

### Keycloak + `coreos/go-oidc`, `golang-jwt`

- **What:** Keycloak is the OIDC identity provider; `go-oidc` + `golang-jwt` validate
  its tokens in the API.
- **Why:** 2b delegates identity to Keycloak so the API never handles credentials
  ([security](./07-spec-platform-security.md), `P2-SEC-1`); the API only needs to validate
  JWTs against Keycloak's JWKS and read the roles claim — no custom crypto.
- **How:** Validation middleware fetches/caches the JWKS, verifies signature/issuer/
  audience/expiry, and maps realm roles to the platform's viewer/operator roles
  ([security §3](./07-spec-platform-security.md#3-roles-and-role-mapping)). **Absent in
  2a** ([security §5](./07-spec-platform-security.md#5-the-2a-unauthenticated-stance)).

---

## Observability (2b)

### Prometheus client + Grafana — `client_golang`

- **What:** `client_golang` exposes `/metrics`; Prometheus scrapes; Grafana renders.
- **Why:** The standard Go metrics path; gives the platform-health dashboards
  ([operations §1](./08-spec-platform-operations.md#1-observability)) with no bespoke
  metrics pipeline.
- **How:** Instrument ingestion rate, API latency/errors, reconciliation actions, and
  per-controller connectivity; Prometheus + Grafana run as 2b Compose services.

### `slog` (standard library)

- **What:** Structured logging.
- **Why:** Stdlib, no dependency; one structured stream serves both operational logs
  and the audit trail
  ([operations §1](./08-spec-platform-operations.md#1-observability)).
- **How:** A JSON handler in production; the change-attribution events from
  [crop profiles](./05-spec-platform-crop-profiles.md#5-fleet-management--operator-control)
  log through it.

---

## Tooling

- **golangci-lint** — aggregated linters; runs in CI.
- **gofmt / goimports** — canonical formatting so diffs stay meaningful.
- **`go test`** — unit + integration tests (handlers, ingester routing, resolution
  mapping); `P2-TEST-*`.
- **Docker / Docker Compose** — single-command local orchestration
  ([operations](./08-spec-platform-operations.md#2-deployment)).

---

## Explicitly rejected

Recorded so the choice isn't re-litigated:

- **A heavyweight web framework (Gin with full middleware stacks, Fiber)** — Echo over
  `net/http` is enough; Fiber's non-`net/http` base complicates WS proxying and
  standard middleware.
- **An ORM as the default (GORM / ent)** — obscures the SQL behind the perf-sensitive
  range/aggregate queries and fights TimescaleDB features; `pgx` + `sqlc` is explicit
  and type-safe.
- **A separate time-series database (InfluxDB) alongside Postgres** — rejected by
  [RFC-002](../../../decisions/request-for-comments.md#rfc-002-phase-2-persistence-layer);
  one TimescaleDB instance serves both shapes.
- **socket.io / SSE for the live channel** — the frontend speaks plain WebSockets; a
  matching server framework is unneeded.
- **A cloud-managed IdP / Auth0** — violates the zero-cloud constraint; Keycloak runs
  locally.
- **Traefik for ingress** — the service map is static; nginx is simpler
  ([RFC-003](../../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress)).
