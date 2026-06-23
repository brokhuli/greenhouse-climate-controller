# Platform (Phase 2)

Local PaaS platform — **Go (Echo)**.

Ingests telemetry off the MQTT broker, stores time-series data in TimescaleDB, and serves a
dashboard API over REST + WebSockets. Conforms to the message schemas in `../contracts/`.
This is the **Phase 2a backend** (the React SPA is a later slice): the bidirectional telemetry
pipeline plus a thin setpoint-edit relay, unauthenticated on the trusted local Docker network
(RFC-011).

## Layout

- `cmd/api/` — service entrypoint; wires migrate → store → ingester → HTTP server.
- `internal/`
  - `config` — env-driven service config.
  - `domain` — shared identity slugs, enums, units, record types.
  - `store` — pgx pool, embedded `golang-migrate` migrations, hand-written SQL (registry +
    telemetry range/analytics).
  - `ingest` — MQTT subscribe/route, bounded buffer + shed-oldest writer, liveness.
  - `state` — in-memory live fleet view (status, time-scale, latest temperature).
  - `api` — Echo handlers, validation, DTOs.
  - `relay` — controller REST client (setpoint + sim-time-scale relay).
  - `ws` — WebSocket frame DTOs + fan-out hub.
- `test/` — DB-backed integration tests (`//go:build integration`).

## Served API (2a)

`/api`-prefixed, snake_case bodies, RFC-007 slugs; `422 {error,field,bound,value}` on rejection.

| Method · Path | Purpose |
|---|---|
| `GET/POST /api/greenhouses` | fleet list / register |
| `GET/DELETE /api/greenhouses/{id}` | detail / retire |
| `PATCH /api/greenhouses/{id}/setpoints` | ad-hoc edit (relayed to the controller) |
| `GET /api/greenhouses/{id}/telemetry?from&to` | raw range |
| `GET /api/greenhouses/{id}/analytics?from&to&metric?&interval?` | time-bucketed aggregates |
| `GET/PATCH /api/greenhouses/{id}/sim/time-scale` · `PATCH /api/sim/time-scale` | sim-only speed relay |
| `GET /api/events?greenhouse_id?&kind?&severity?` | activity feed |
| `GET /api/stream` | WebSocket live fan-out (telemetry / status / event) |

> **Implementation note.** The data-access layer is hand-written SQL on `pgx` rather than
> `sqlc`: the dynamic analytics query (`time_bucket` with a runtime interval + optional metric
> filter) and TimescaleDB's `create_hypertable` fit poorly with sqlc's static-query codegen.
> This keeps the "raw, explicit, no-ORM" discipline the tech-stack spec calls for while dropping
> a build-time tool. Setpoints are **not** persisted in 2a (that is the 2b intended-state layer),
> so `GET /api/greenhouses/{id}` reads the controller's current bundle live and returns `503`
> when the controller is unreachable.

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `PLATFORM_DATABASE_URL` | _(required)_ | TimescaleDB DSN (`postgres://…`) |
| `PLATFORM_MQTT_BROKER_URL` | `tcp://localhost:1883` | MQTT broker |
| `PLATFORM_HTTP_ADDR` | `:8080` | REST + WS bind |
| `PLATFORM_RETENTION_DAYS` | `30` | telemetry retention horizon |
| `PLATFORM_INGEST_BUFFER` | `4096` | bounded ingest buffer |
| `PLATFORM_OFFLINE_AFTER_SECS` | `10` | liveness no-contact horizon (1×) |
| `PLATFORM_RELAY_TIMEOUT_SECS` | `5` | downward controller-call timeout |

## Development Commands

```sh
cd climate-platform

# format / lint / vet / build / test
gofmt -w .
golangci-lint run ./...
go vet ./...
go build ./...
go test ./...                          # unit tests (no Docker)

# DB-backed integration tests (starts a real TimescaleDB via testcontainers; needs Docker)
go test -tags integration ./test/... -timeout 360s
```

The whole stack (broker + DB + this API + N simulated controllers) is brought up with Docker
Compose — see [`../deploy/README.md`](../deploy/README.md).
