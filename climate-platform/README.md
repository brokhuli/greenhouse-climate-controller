# Platform (Phase 2)

Local PaaS platform — **Go (Echo)**.

Ingests telemetry off the MQTT broker, stores time-series data in TimescaleDB, and serves a
dashboard API over REST + WebSockets. Conforms to the message schemas in `../contracts/`.

Covers **Phase 2a** (the bidirectional telemetry pipeline plus a thin setpoint-edit relay) plus
the **2b backbone**: crop profiles, setpoint **resolution**, an append-only intended-state /
provenance ledger, and **reconciliation** (apply-on-change, re-assert on reconnect, drift
detection). The platform is now the single setpoint authority (RFC-005). **Auth has landed**:
Keycloak-issued OIDC tokens are validated by the API, which gates every write to the **operator**
role — reads stay open (a missing token is served as an anonymous viewer; an invalid one is
rejected). **Observability has landed** too: the API exposes `/metrics`, scraped by Prometheus and
rendered in Grafana alongside each controller's own `/metrics` — so the 2b platform slice is complete
(see `../docs/backlog.md`).

## Layout

- `cmd/api/` — service entrypoint; wires migrate → store → ingester → HTTP server.
- `internal/`
  - `config` — env-driven service config.
  - `domain` — shared identity slugs, enums, units, record types.
  - `store` — pgx pool, embedded `golang-migrate` migrations, hand-written SQL (registry +
    telemetry range/analytics + crop profiles, assignments, intended-state/provenance ledger,
    reconciliation state, and the provenance-prune job).
  - `ingest` — MQTT subscribe/route, bounded buffer + shed-oldest writer, liveness.
  - `state` — in-memory live fleet view (status, time-scale, latest climate) plus the Phase 3
    controller snapshot (mode, per-actuator readback health, active sensor faults) the
    planning-context read serves from the retained state frame.
  - `reconcile` — the control-down engine (2b): resolves profiles, records intended state, delivers
    to the controller, and runs the re-assert/drift loop (staggered, idempotent, rate-limited).
  - `api` — Echo handlers, validation, DTOs.
  - `optimizer` — typed client for the Phase 3 optimizer's FastAPI Service API, which the API
    proxies/aggregates into the versioned dashboard optimizer console (3).
  - `relay` — controller REST client (setpoint + zone + sim-time-scale calls).
  - `ws` — WebSocket frame DTOs (incl. `drift`) + fan-out hub.
- `test/` — DB-backed integration tests (`//go:build integration`).

## Served API

`/api`-prefixed, snake_case bodies, RFC-007 slugs; `422 {error,field,bound,value}` on rejection.

| Method · Path | Purpose | Slice |
|---|---|---|
| `GET/POST /api/greenhouses` | fleet list / register | 2a |
| `GET/DELETE /api/greenhouses/{id}` | detail (incl. `drift`) / retire | 2a |
| `PATCH /api/greenhouses/{id}/setpoints` | ad-hoc edit — sticky intended state, reconciled | 2a/2b |
| `GET /api/greenhouses/{id}/telemetry?window` | raw range | 2a |
| `GET /api/greenhouses/{id}/analytics?window&metric?&interval?` | time-bucketed aggregates | 2a |
| `GET/PATCH /api/greenhouses/{id}/sim/time-scale` · `PATCH /api/sim/time-scale` | sim-only speed relay | 2a |
| `GET /api/events?greenhouse_id?&kind?&severity?` | activity feed | 2a |
| `GET /api/stream` | WebSocket live fan-out (telemetry / status / event / drift) | 2a/2b |
| `GET/POST /api/profiles` · `GET/PATCH/DELETE /api/profiles/{id}` | crop-profile library CRUD | 2b |
| `GET/PUT /api/greenhouses/{id}/assignment` | current profile/stage · assign + apply | 2b |
| `POST /api/greenhouses/{id}/setpoints` | optimizer single-authority write (RFC-005/011) | 2b/3 |
| `GET /api/greenhouses/{id}/planning-context?window?&interval?` | Phase 3 optimizer read path: current setpoints + crop-safe bounds, bucketed telemetry summaries, latest actuator states, data-quality/freshness signals | 3 |
| `GET /api/optimizer/{status,fleet,model,enabled,escalations}` · `GET /api/optimizer/greenhouses/{id}/{plan,enabled}` | optimizer console reads — proxy/aggregate over the optimizer Service API (status derived, plan diff composed) | 3 |
| `POST /api/optimizer/{model,enabled}` · `POST /api/optimizer/greenhouses/{id}/{cycles,enabled}` · `POST /api/optimizer/escalations/{id}/resolve` | optimizer console mutations (operator-gated; the caller's token is forwarded to the optimizer) | 3 |

> **Implementation note.** The data-access layer is hand-written SQL on `pgx` rather than
> `sqlc`: the dynamic analytics query (`time_bucket` with a runtime interval + optional metric
> filter) and TimescaleDB's `create_hypertable` fit poorly with sqlc's static-query codegen.
> This keeps the "raw, explicit, no-ORM" discipline the tech-stack spec calls for while dropping
> a build-time tool. `GET /api/greenhouses/{id}` still reads the controller's current bundle live
> (returning `503` when the controller is unreachable) and now also reports `drift` — whether that
> reported bundle diverges from the platform's intended state. A crop-profile assignment or an
> ad-hoc edit is resolved, recorded in the provenance ledger, and delivered through the reconciler;
> when a controller is offline the change is held and re-asserted on reconnect.

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
| `PLATFORM_RECONCILE_INTERVAL_SECS` | `30` | reconciliation loop cadence (re-assert + drift check) |
| `PLATFORM_REASSERT_JITTER_SECS` | `3` | max per-greenhouse stagger within a reconcile cycle |
| `PLATFORM_DRIFT_MAX_RETRIES` | `5` | failed deliveries/corrections before backing off (drift stays surfaced) |
| `PLATFORM_PROVENANCE_PRUNE_DAYS` | `30` | window past which superseded setpoint revisions are pruned |
| `PLATFORM_OPTIMIZER_URL` | `http://optimizer:8000` | Phase 3 optimizer Service API the console proxies |
| `PLATFORM_OPTIMIZER_TIMEOUT_SECS` | `5` | per-call timeout on the optimizer proxy hop |
| `PLATFORM_OPTIMIZER_CADENCE_SECS` | `1800` | fallback cadence the status badge ages against before the optimizer is first reached |

> The service-auth mode (`PLATFORM_SERVICE_AUTH_MODE`, `trusted_network` default | `oidc`) and the
> OIDC issuer/discovery/audience vars gate the write boundaries (RFC-011); see
> [`../docs/decisions/request-for-comments.md`](../docs/decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009).

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
