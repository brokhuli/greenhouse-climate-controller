# Request for Comments

This file tracks design proposals that are **open for comment before implementation begins**. Each RFC
describes a complete proposed design — not just a question — so reviewers have something concrete to
evaluate and improve.

**Lifecycle:** `Draft` → `Open for Comment` → `Accepted` / `Rejected`. Once accepted, the decision
and its rationale move to [`architecture-design-record.md`](./architecture-design-record.md) (for
architecture) or [`local-environment-record.md`](./local-environment-record.md) (for tooling /
environment). The RFC is then marked `Accepted` and kept here as a permanent record.

> **Full system design:** The complete design for all phases — architecture, tech stack, physical
> system, and control logic — is in [`../specs/design/`](../specs/design/). Reviewers unfamiliar
> with the system should read [`high-level-idea.md`](../specs/design/high-level-idea.md) first for
> an end-to-end overview before evaluating individual RFCs.

---

## RFC-001: MQTT Broker Selection

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |

### Summary

Use **Mosquitto** as the MQTT broker for all phases, running as a Docker Compose service shared by
the controller (Phase 1), the platform (Phase 2), and the optimizer (Phase 3).

### Problem

The spec requires an MQTT broker with QoS and retained-message support. Two options appear throughout
the design docs without a decision: Mosquitto and EMQX. The broker is a shared dependency across all
three phases, so the choice affects every phase's Compose stack and any MQTT-specific configuration
(auth, ACLs, topic patterns).

### Proposal

Run **Mosquitto** as the `mqtt` service in the shared Compose stack.

Configuration approach:
- **Anonymous auth** for local development (no credentials on localhost).
- **QoS 1** for sensor telemetry (at-least-once delivery; small retransmit risk acceptable over
  loopback; QoS 2 overhead unnecessary).
- **Retained messages** for last-known device state (controller publishes retained; Phase 2 ingestion
  and Phase 3 optimizer can subscribe and immediately have current state on connect).
- **Persistence enabled** so retained messages and in-flight QoS state survive broker restarts.
- **`mosquitto_pub` / `mosquitto_sub`** are available inside the container via `docker exec` —
  sufficient for hand-debugging topic traffic without a separate host install.

The broker abstraction is pure MQTT, so no application code depends on Mosquitto specifically.
Swapping to EMQX later is a Compose and config change, not a code change.

### Alternatives Considered

**EMQX** — ships a built-in web dashboard, clustering, and richer per-client ACL support. None of
these are required by the spec: the system is single-site, local-only, and does not need clustering
or fine-grained auth. The additional resource footprint and configuration surface are not justified
by the required feature set (QoS + retained).

### Open Questions

- Will Phase 2's multi-greenhouse ingestion surface a reason to want per-client ACLs that would make
  EMQX worth its weight?

### Resolution

**Accepted 2026-06-07 — Mosquitto.** See ADR entry 2026-06-07.

---

## RFC-002: Phase 2 Persistence Layer

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |

### Summary

Use **TimescaleDB** (the PostgreSQL extension) from day one as Phase 2's single store. Relational
metadata lives in ordinary tables; the high-volume telemetry tables are created as **hypertables**
in the initial migration.

### Problem

Phase 2 uses a single store for two distinct workloads: **relational metadata** (greenhouse
registry, crop profiles, user assignments, growth-stage schedules) and **high-volume time-series
telemetry** (sensor readings from every greenhouse, every sample interval). TimescaleDB is the
correct fit for the telemetry workload, and because it is a Postgres *extension* — not a separate
database — it serves the relational metadata with stock PostgreSQL semantics in the same instance.
The only real choice is *when* to adopt it: from the first migration, or after a later cutover.

### Proposal

Run the **`timescale/timescaledb:latest-pg16`** image as the `db` service from day one. Migration
tooling and all relational DDL are standard PostgreSQL; the TimescaleDB extension adds hypertable
support on top.

The store layout:

| Schema area | Tables | Storage |
|---|---|---|
| Greenhouse registry | `greenhouses`, `zones` | Ordinary relational tables; low row count |
| Crop profiles | `crop_profiles`, `growth_stages`, `setpoint_templates` | Ordinary relational; updated infrequently |
| Greenhouse ↔ profile assignments | `greenhouse_profiles` | Foreign keys to both schemas |
| Telemetry | `sensor_readings`, `actuator_events` | **Hypertables** (`create_hypertable` in the initial migration) |

The initial migration:
1. `CREATE EXTENSION IF NOT EXISTS timescaledb;`
2. Creates the relational tables as ordinary Postgres tables.
3. Creates the telemetry tables, then converts each with `SELECT create_hypertable('sensor_readings', 'time')` (and likewise for `actuator_events`).
4. Adds a retention/compression policy on the telemetry hypertables (`add_retention_policy`,
   `add_compression_policy`) so unbounded telemetry growth is handled from the start.

The relational tables and the hypertables coexist in the one instance and join normally — e.g.,
crop-profile metadata joined against recent `sensor_readings` is a single query, no cross-store
plumbing.

### Alternatives Considered

**Plain Postgres now, add TimescaleDB later** — start on the stock `postgres:16` image with telemetry
as ordinary tables, and convert to hypertables once volume justifies it. Rejected: it defers a
decision that is already made (the telemetry workload is unambiguously time-series), leaves the
telemetry tables without time-range chunking and retention in the interim, and adds a later cutover
step (swap image, run `create_hypertable`, add policies) for no benefit. Committing now removes that
future migration and gives correct telemetry physical layout from the first insert.

**Separate stores** (Postgres for relational, TimescaleDB/InfluxDB for telemetry) — matches a
production multi-service design. Rejected because it introduces a second connection pool,
second migration pipeline, and cross-store join complexity (crop-profile metadata + telemetry
queries are naturally joined) for no benefit at local scale.

### Open Questions

- What chunk interval and retention/compression window fit the expected telemetry rate (controller
  count × sensor count × sample interval)? These are hypertable-policy *parameters* to tune, not
  blockers — defaults are fine to start, with a Phase 2 load test to refine them.

### Resolution

**Accepted 2026-06-07 — TimescaleDB from day one.** See ADR entry 2026-06-07.

---

## RFC-003: Phase 2 Platform Ingress

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |

### Summary

Use a single **nginx** container as the platform's one entry point: it serves the built React SPA
*and* reverse-proxies `/api` and `/auth` to the Go API and Keycloak. nginx is the only proxy in the
stack — Traefik is not used.

### Problem

Phase 2 runs several services that a browser or CLI client needs to reach: the Go API, Keycloak
(OIDC), and the React SPA. The design docs ([spec-climate-platform.md §10](../specs/design/spec-climate-platform.md#10-reverse-proxy--routing))
call for a single reverse proxy as the platform's one entry point but list "Traefik or nginx"
without deciding which.

### Proposal

A single **nginx** container is both the SPA's static server and the reverse proxy — one ingress on
`:80` (`:443` when local TLS is added):

| Path | Proxied to | Notes |
|---|---|---|
| `/` | React SPA static files | Served directly by nginx from the built bundle |
| `/api` | `api` (Go + Echo) | HTTP + WebSocket upgrade for live telemetry fan-out |
| `/auth` | `auth` (Keycloak) | OIDC flows; single hostname keeps redirect URIs stable |

Internal service ports (`api`, `auth`, `db`, `mqtt`) stay on the Compose network and are not the
browser's concern. They can still be published to the host during development for direct debugging,
but the SPA and OIDC flows go through the single nginx entry point.

**Why nginx fits here specifically:** the routing map is static — services are named, config-driven
Compose services (the controllers are generated as named services, not `docker compose --scale`
replicas, per [spec-climate-platform.md §12](../specs/design/spec-climate-platform.md#12-deployment)).
nginx already serves the SPA regardless, so folding the `/api` and `/auth` proxy rules into that same
container adds one config file and no new component. Static `proxy_pass` upstreams are exactly nginx's
strength when the service map does not churn at runtime.

### Alternatives Considered

**Traefik** — label-based Docker service discovery and dynamic reconfiguration as containers come and
go. Rejected because its core advantage (runtime discovery) brings no benefit here: the platform
services and the generated controllers are static, named, config-driven services, so there is nothing
to dynamically discover. It would add a second proxy component alongside the nginx that already serves
the SPA, for routing nginx handles with a static config.

**No dedicated proxy — reach each service on its own host port** — simplest for early local dev.
Rejected as the committed design because it leaves the SPA and API on distinct ports, which makes
OIDC redirect URIs fragile and contradicts the single-entry-point design in §10. (Direct port access
remains available in dev for debugging; it just isn't the platform's ingress.)

### Open Questions

- Local TLS (`:443`) is deferred until an HTTPS-only browser API actually needs it; terminating TLS
  at this same nginx is a config addition, not a structural change. No blocker.

### Resolution

**Accepted 2026-06-07 — single nginx (SPA server + reverse proxy).** See ADR entry 2026-06-07.

---

## RFC-004: Phase 3 LLM Integration Interface

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |

### Summary

Define a **backend-agnostic LLM interface** in the Python optimizer. Use a **hosted LLM**
(Anthropic or OpenAI) as the primary planning backend, with **Ollama** as the local fallback when
the hosted backend is unavailable or unconfigured. A single **backend-agnostic invocation strategy**
— fixed token budget, hourly telemetry summaries, adaptive horizon, state-change gate, and fixed
cycle cadence — governs all LLM calls regardless of which backend is active.

### Problem

The optimizer (Phase 3) uses an LLM to generate actuator plans from simulation state and constraints.
Two competing constraints apply: hosted frontier models produce higher-quality, more reliably
constraint-valid plans, but introduce per-token cost and a network dependency; local models
(Ollama) are free and offline but have smaller context windows and lower capability for complex
multi-variable planning. Neither pure choice is satisfactory. The design docs explicitly call this
layer "flexible by design — this layer evolves as LLM capabilities do."

### Proposal

**Backend protocol**

Introduce a `PlannerBackend` protocol (Python `Protocol` or abstract base class) in the optimizer
service:

```
PlannerBackend
  generate_plan(context: PlanContext) -> ActuatorPlan
```

`PlanContext` carries the digital-twin simulation state, current setpoints, crop-safe bounds, and
cost/time-of-use signals. `ActuatorPlan` carries refined setpoints and a reasoning trace for audit.

**Primary backend: hosted API**
- Enabled by setting `PLANNER_BACKEND=anthropic` (or `openai`) and supplying an API key.
- Provides higher capability for constraint-valid multi-variable plan generation.
- Docker Desktop containers on the host machine have outbound internet access by default; no special
  networking configuration is required to reach hosted API endpoints.

**Fallback backend: Ollama**
- Activated automatically when the hosted backend is unreachable or `PLANNER_BACKEND=ollama` is set.
- Runs locally via the `ollama` container in the Compose stack; no API key, no data leaving the host.
- Model is configured via `PLANNER_MODEL` (e.g. `llama3`); not pinned in code.
- When the hosted backend fails mid-cycle, the optimizer falls back to Ollama for that cycle, logs a
  warning, and retries the hosted backend on the next cycle.

The constraint-validation layer (safety bounds, crop limits) runs in Python *after* the LLM
generates a plan, regardless of which backend produced it. No actuator plan reaches the controller
without passing constraint validation.

**Backend-agnostic invocation strategy**

Context preparation and call gating are the optimizer's responsibility, applied before
`generate_plan()` is called. The backend never sees raw data and is never aware of which preparation
decisions were made. This makes the strategy work identically for both backends:

| Lever | What it does |
|---|---|
| **Fixed token budget** | `PlanContext` is serialized to a fixed token budget (e.g. 4 000 tokens) before being passed to any backend. Sized to fit a capable local model's context window, ensuring hosted models receive the same compact context. If serialization exceeds the budget the serializer raises an explicit error — no silent truncation. |
| **Hourly telemetry summaries** | Serialize `(min, mean, max)` per sensor per hour, not raw readings. 24 h at 1-minute resolution is up to 1 440 rows × N sensors; summaries reduce this to 24 rows regardless of sample rate. |
| **Adaptive planning horizon** | Default to a 12-hour horizon; extend to 24 h only when the cycle window crosses a day boundary (within 4 h of a sunrise/sunset transition). Most cycles do not need the full horizon. |
| **State-change gate** | Before invoking the LLM, compare the current simulated trajectory against the trajectory used in the last accepted plan. If per-variable deviation is below a configurable threshold, skip the LLM call and extend the current plan. Suppresses calls during stable periods; especially valuable for local inference where each call costs seconds of GPU time. |
| **Fixed cycle cadence** | Default cadence of 30 minutes (configurable). Combined with the state-change gate, actual LLM calls are well below the maximum cadence. The cadence bounds the worst case; the gate controls the typical case. |

### Token and Context Management

The invocation strategy above is the token and context management strategy. It is fully specified in
the Proposal — no separate section is needed. Key properties:

- The token budget is a single config value (`llm.context_token_budget`), not a per-backend setting.
- Prompt caching (an Anthropic-specific API feature) is **out of scope** for the protocol contract.
  It may be layered onto the hosted backend implementation if cost warrants it, without changing
  the `PlannerBackend` interface or the invocation strategy.

### Alternatives Considered

**Lock in Ollama only** — simpler initially; no abstraction layer. Rejected because the design docs
explicitly anticipate swapping models, and the `Protocol` boundary is a one-time, low-cost seam that
prevents a rewrite if a local model proves insufficient.

**Hosted API only, no local fallback** — higher plan quality, simpler code (no fallback path).
Rejected because Ollama fallback preserves planning continuity when the hosted backend is
temporarily unreachable (network outage, API downtime), and adding it costs only one additional
`PlannerBackend` implementation behind the same protocol.

**Local Ollama only, no hosted backend** — fully offline, zero cost. Rejected because a 7B–13B
class local model may not reliably produce constraint-valid plans for the Phase 3 multi-variable
planning scenario; the hosted backend is the primary path precisely to ensure plan quality.

**Per-backend context strategy** — size and compress `PlanContext` differently depending on whether
the backend is local or hosted. Rejected because it couples context preparation to backend selection,
requires branching logic outside the `PlannerBackend` abstraction, and makes the system harder to
reason about when switching backends. A single conservative budget works for both.

### Open Questions

- What token budget and state-change deviation threshold produce acceptable plan quality in
  practice? Reasonable defaults (4 000 tokens, 5% deviation) should be validated once a model
  and test scenario are in place.
- What is the right default cycle cadence given the Phase 3 scenario's expected greenhouse count
  and planning complexity? 30 minutes is a reasonable starting point but should be validated
  against actual inference latency on target hardware.

### Resolution

**Accepted 2026-06-07 — hosted LLM primary (Anthropic/OpenAI), Ollama local fallback, backend-agnostic
invocation strategy.** See ADR entry 2026-06-07.

---

## RFC-005: Setpoint Authority and Delivery Chain

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |

### Summary

Make **Phase 2 the single authority for controller setpoints**. The Phase 3 optimizer submits
refined setpoints to Phase 2's setpoint API; Phase 2 validates them against crop-safe bounds and
pushes them to the controller via the Phase 1 REST config API. The optimizer never writes setpoints
directly to the controller.

### Problem

Two paths exist for the optimizer to deliver refined setpoints to the Phase 1 controller: through
Phase 2's existing setpoint API (the same path crop profiles already use) or directly over MQTT.
The controller is setpoint-only — it does not accept raw actuator commands; it regulates to setpoints.
Phase 2 already holds the crop-safe bounds (from crop profiles) that constrain any setpoint change.
If the optimizer bypasses Phase 2, those bounds must be re-enforced somewhere else, and setpoint
provenance (which component wrote which value, and when) is split across two systems.

### Proposal

**Setpoint write path (all sources):**

```
Crop profile assignment (Phase 2 operator)
         │
         ▼
Phase 2 setpoint API  ◄── Phase 3 optimizer (refined targets, within crop-safe bounds)
         │
         ▼ (Phase 1 REST config API)
Phase 1 controller
```

Phase 2 owns three responsibilities in this chain:
1. **Bounds enforcement** — rejects any setpoint (whether from a crop profile or the optimizer)
   that falls outside the crop-safe window for the assigned profile and growth stage.
2. **Provenance recording** — each setpoint write is stored with its source (`crop_profile`,
   `optimizer`, `manual_override`), timestamp, and value, giving a full audit trail in Postgres.
3. **Delivery** — pushes accepted setpoints to the controller via the Phase 1 REST config API.

The optimizer's contract with Phase 2 is a setpoint-submission endpoint:
`POST /greenhouses/{id}/setpoints` with a body that includes the refined targets and an
`optimizer_run_id` for tracing. Phase 2 validates and either accepts (202) or rejects (422 with
the violated bound).

The controller is never aware of whether the current setpoints came from a crop profile or the
optimizer — it regulates to whatever Phase 2 last pushed.

### Alternatives Considered

**Optimizer publishes setpoints directly over MQTT** — lower latency, no dependency on Phase 2
being up. Rejected because it creates a second authority over setpoints, requiring the optimizer
to independently re-implement crop-safe bounds validation and losing centralized provenance.
The latency advantage is irrelevant: setpoint changes are low-frequency (minutes-scale), not
real-time actuator commands.

**Optimizer calls the Phase 1 REST config API directly** — same problems as direct MQTT: bypasses
Phase 2's bounds validation and audit, and creates a direct Phase 3 → Phase 1 dependency that
the layer separation is designed to prevent.

### Open Questions

- ~~Does any Phase 3 planning scenario require a setpoint-change cadence fast enough that a REST
  round-trip through Phase 2 becomes a bottleneck?~~ **Resolved by [RFC-004](#rfc-004-phase-3-llm-integration-interface):**
  the optimizer plans on a fixed cycle cadence (default 30 minutes), so setpoint changes are
  minutes-scale at most. A REST round-trip through Phase 2 is never a bottleneck at this frequency.

### Resolution

**Accepted 2026-06-07 — Phase 2 is the single authority for controller setpoints.** All setpoint
sources (crop-profile assignment, operator override, Phase 3 optimizer) write through the Phase 2
setpoint API; Phase 2 enforces crop-safe bounds, records provenance, and is the sole delivery path
to the Phase 1 controller. See ADR entry 2026-06-07.

---

## RFC-006: Phase 4 Seam Strategy

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |
| Priority | Lowest — does not block Phases 1–3 |

### Summary

Implement Phases 1–3 exactly as specified, with **one targeted constraint on the Phase 1 HAL
actuator interface**: do not encode the assumption that one actuator affects exactly one climate
variable. No combustion code, no weather feed, and no actuator-selection logic lands until Phase 3
ships.

### Problem

Phase 4 introduces a combustion heater — a single device that raises temperature, CO₂, and humidity
simultaneously — which explicitly breaks Phase 1's independent-loop assumption. If the Phase 1 HAL
actuator interface hard-codes "one actuator → one climate variable" (e.g., a trait method that pairs
an actuator to a single sensor target), adding the combustion heater in Phase 4 would require a
rewrite of the HAL layer rather than an additive extension. This is the one place where a small
early choice has a disproportionate later cost.

Phase 4 also extends the Phase 3 digital twin with weather-reactive planning, but the twin's
disturbance model is an internal Python concern — Phase 4 accommodation there costs nothing during
Phase 3 implementation.

### Proposal

**Phase 1 HAL interface constraint (the only Phase 4 accommodation):**

Define the actuator trait so that an actuator produces a *set of effects on climate variables*,
not a one-to-one mapping. Concretely: the trait should not have a field or type parameter that
constrains an actuator to a single target variable. The existing simulated actuators (heater →
temperature, mister → humidity, CO₂ injector → CO₂) each happen to affect one variable, but the
interface should not encode that as an invariant.

This is a zero-cost constraint on the *shape* of the trait — it does not add any combustion logic,
does not add a coupled-actuator implementation, and does not affect the Phase 1 controller's
complexity rating. It means the Phase 4 combustion heater can be added as a new HAL backend that
implements the same trait, without changing the trait or the control loops above it.

Everything else is deferred:
- No combustion heater implementation, even behind a feature flag.
- No weather feed ingestion, no forecast data structures.
- No actuator-selection coordination layer above the PIDs.
- No Phase 4 changes to the Phase 3 digital twin (the twin's disturbance model can receive a
  weather series or a diurnal profile through the same input; this needs no Phase 3 change).

### Alternatives Considered

**Hard defer — no Phase 4 accommodation at all** — build Phases 1–3 to spec with no Phase 4
awareness. Clean, no risk of over-engineering. Rejected only because the HAL interface shape costs
nothing to get right now, and the alternative is a HAL rewrite at the start of Phase 4 rather than
an additive implementation.

**Design seams across multiple layers** — extend the Phase 3 twin's disturbance API, sketch the
actuator-selection coordination layer in Phase 2, etc. Rejected: the twin's disturbance model
requires no Phase 3 change (a weather series and a diurnal profile are the same input type), and
pre-building coordination logic in Phase 2 adds Phase 4 complexity to a layer that should stay at
6/10 until Phase 4 is actually in scope.

### Open Questions

- ~~Does avoiding "one actuator → one variable" in the HAL trait require any design that bleeds Phase
  4 complexity into the Phase 1 rule engine or PID wiring, or is it genuinely limited to the trait
  definition?~~ **Resolved: genuinely limited to the trait definition.** The coupling between an
  actuator and the climate variables it affects already lives in the HAL simulation's coupling matrix
  ([P1 §3](../specs/design/spec-climate-controller.md#3-hal--simulation-model)), not in the control
  loops. The PIDs target *variables*, not actuators, so the actuator→variable cardinality never
  reaches the rule engine or PID wiring. Deciding *which* coupled actuator to use when several affect
  one variable is the Phase 4 actuator-selection layer — explicitly deferred, and additive above the
  unchanged loops.

### Resolution

**Accepted 2026-06-07 — implement Phases 1–3 to spec, with the single constraint that the Phase 1
HAL actuator interface must not encode "one actuator → one climate variable" as an invariant.** No
combustion code, weather feed, or actuator-selection logic lands before Phase 4. See ADR entry
2026-06-07.
