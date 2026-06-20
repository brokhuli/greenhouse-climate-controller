# Platform — Operations (Observability & Deployment)

> **Purpose:** Define how the platform is **observed** and how it is **deployed** —
> the two operational concerns of running the stack. Observability is about *platform
> health* (the services), distinct from the greenhouse telemetry the platform ingests.
> Deployment is the local Docker Compose model for the platform plus the N controllers
> it manages. Quality targets (target controller counts, latencies) live in the
> [NFR doc](../../artifacts/non-functional-requirements.md).

---

## 1. Observability

> **Phase 2b.** Prometheus + Grafana are a 2b addition; the 2a MVP runs without them
> (the Go API's structured logs are still available).

The platform instruments **itself**, distinct from the greenhouse telemetry it
ingests ([ingestion](./04-spec-platform-ingestion.md)).

### Platform health, not crop climate

This distinction is load-bearing. Greenhouse readings (temperature, humidity, soil
moisture, …) live in the time-series store and the dashboard
([data model](./03-spec-platform-data-model.md),
[dashboard](./06-spec-platform-dashboard.md)). Observability here is about the **service**
— is ingestion keeping up, is the API healthy, are controllers connected — never about
the crops.

### Metrics

The Go API exposes **`/metrics`**; **Prometheus** scrapes it; **Grafana** renders
platform dashboards. The metric catalog covers, at minimum:

| Metric area | What it shows |
|---|---|
| Ingestion rate | Messages/sec ingested per stream and fleet-wide; lag/backlog |
| API latency & errors | Request latency distribution (toward `P2-PERF-3` p95 < 200 ms) and error rate |
| Reconciliation actions | Profile applies, re-asserts on reconnect, drift detections/corrections |
| Per-controller connectivity | Online/degraded/offline transitions per greenhouse |
| Datastore | Connection-pool usage, query latency, retention/prune/aggregate job health |

The proxy exposes nothing extra for metrics; Prometheus scrapes the API directly over
the internal network.

### Structured logs & audit

The API emits **structured logs** (Go `slog`) for operational events and the audit
trail. Every downward write recorded as a change-attribution event
([crop profiles](./05-spec-platform-crop-profiles.md#5-fleet-management--operator-control))
appears in the log stream with who/what/when, so the audit trail and the operational
log share one structured pipeline.

---

## 2. Deployment

The whole stack — platform services and controllers — runs locally under **Docker
Compose**, no cloud account.

### Platform services

The **2a** MVP stands up only the telemetry-pipeline + frontend services; **2b** adds
authentication and observability.

| Service | Implementation | Slice |
|---|---|---|
| `api` | Go + Echo | 2a |
| `db` | TimescaleDB (PostgreSQL + extension) | 2a |
| `mqtt` | Mosquitto | 2a |
| `proxy` | nginx (single entry point; also serves the SPA) | 2a |
| `frontend` | Built React app served by the `proxy` nginx | 2a |
| `auth` | Keycloak — self-hosted OIDC identity provider ([security](./07-spec-platform-security.md)) | 2b |
| `prometheus` | Prometheus — scrapes the API's `/metrics` ([§1](#1-observability)) | 2b |
| `grafana` | Grafana — platform dashboards ([§1](#1-observability)) | 2b |

The platform's own service configuration — database DSN, MQTT broker address, Keycloak
client credentials (2b), proxy routing — is supplied via **environment variables / the
Compose file**, not a per-greenhouse config (contrast the controller's TOML).
Per-greenhouse data lives in the registry and assignments
([data model](./03-spec-platform-data-model.md)).

### Controller services

Phase 1 controllers run as **Docker containers on the same local machine**, not on
physical devices. Because the controller HAL is pure simulation
([controller HAL](../controller/03-spec-controller-hal-simulation.md)), there is no
hardware dependency — each controller is a lightweight Rust process that connects to
the platform over the local Docker network.

Controllers are defined as **named services in a generated
`docker-compose.override.yml`** — one named service per greenhouse, each mounting its
own TOML config file. The TOML supplies the controller's unique `controller_id` and all
per-greenhouse parameters (setpoints, HAL simulation params, zone config).
`docker compose up -d` reconciles the full stack in one command.

A generation script takes N (the desired greenhouse count) as input and produces the
override file:

```
scripts/gen-controllers.sh N   →   docker-compose.override.yml (N named controller services)
docker compose up -d           →   brings up platform + N controllers
```

`--scale` is not used because each controller requires a distinct identity and its own
TOML — named services with per-service config mounts are required.

**Why named services over `--scale`:** `docker compose up --scale controller=N`
produces N identical containers. Each controller needs a unique `controller_id` (so it
registers as a distinct greenhouse) and independent simulation parameters — `--scale`
cannot supply per-replica configuration.

### Resource isolation & recovery

The whole stack and 20–50 controllers share **one host**
([constraints — deployment & scale](../../artifacts/constraints.md#deployment--scale)),
so "independent failure domain" has to hold at the *compute* level, not just in physics
([constraints §6](./11-spec-platform-constraints.md#6-manages-does-not-couple-physics)).
The Compose definition makes that explicit:

- **Per-service CPU/memory limits.** Each service — platform and controller alike —
  declares CPU and memory limits so a runaway or wedged container cannot starve the
  others on the shared host. The controller limits are sized to its footprint budget
  (`P1-PERF-4`: ≤ 50 MB resident, ≤ 5% of a core), which is what makes 20–50 of them
  co-resident with the platform predictable rather than a contention gamble.
- **Restart policies + healthchecks.** Services run with a restart policy
  (`restart: unless-stopped`) and a per-service healthcheck, so a crashed or
  unresponsive container is restarted automatically — the local stand-in for an
  orchestrator's self-healing, in service of `P2-AVAIL-1`. A platform restart never
  interrupts the controllers' own loops.
- **Bounded platform logs.** The API's structured `slog` / audit stream
  ([§1](#1-observability)) is rotated/size-capped so it cannot fill the disk — the
  log-side sibling of the telemetry **retention** policy
  ([ingestion §5](./04-spec-platform-ingestion.md#5-retention--downsampling)).
- **Bounded provenance ledger.** The append-only setpoint revision / provenance ledger
  is pruned on a schedule so the one unbounded *relational* table cannot grow without
  limit — the relational sibling of telemetry retention, keeping each greenhouse's
  current revision while dropping superseded history past its window
  ([data model §2](./03-spec-platform-data-model.md#2-why-the-split)).
- **Migration-on-startup is the startup gate.** Schema migrations run on `api` startup
  ([tech stack](./10-spec-platform-tech-stack.md)); a failed migration blocks the API from
  coming up. This is reversible — migrations are versioned
  `golang-migrate` files — but it is the one place a bad change halts the platform rather
  than degrading it, so migrations are reviewed as carefully as code.

### Performance testing

Varying N in the generation script is the primary mechanism for **performance testing**
the platform under different greenhouse counts. Because the HAL is simulation, many
controllers can run concurrently on a developer machine. The NFR doc captures what to
observe and target controller counts (`P2-SCAL-1`) — see
[`non-functional-requirements.md`](../../artifacts/non-functional-requirements.md).

---

## 3. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The container topology being deployed | deploys | [`02-spec-platform-architecture.md`](./02-spec-platform-architecture.md) |
| The auth service (Keycloak) stood up in 2b | runs | [`07-spec-platform-security.md`](./07-spec-platform-security.md) |
| The greenhouse telemetry (not platform metrics) | distinct from | [`03-spec-platform-data-model.md`](./03-spec-platform-data-model.md), [`06-spec-platform-dashboard.md`](./06-spec-platform-dashboard.md) |
| The controllers being generated/run | manages | [controller deployment](../controller/02-spec-controller-architecture.md#8-deployment) |
| The shared-host resource envelope the per-service limits enforce | defers to | [constraints — deployment & scale](../../artifacts/constraints.md#deployment--scale) |
| Target controller counts, latencies (`P2-SCAL-1`, `P2-PERF-3`) | defers to | [NFR doc](../../artifacts/non-functional-requirements.md) |
