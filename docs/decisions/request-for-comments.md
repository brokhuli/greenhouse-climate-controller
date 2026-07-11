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
4. Adds a retention policy on the telemetry hypertables (`add_retention_policy`) so
   unbounded telemetry growth is handled from the start.

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

- What chunk interval and retention window fit the expected telemetry rate (controller
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
(OIDC), and the React SPA. The design docs ([02-spec-platform-architecture.md](../specs/design/platform/02-spec-platform-architecture.md#4-reverse-proxy--the-edge))
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
replicas, per [08-spec-platform-operations.md](../specs/design/platform/08-spec-platform-operations.md#2-deployment)).
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

> **Revision (2026-06-11 — supersedes the Proposal below):** The `PlannerBackend` protocol defined
> in the Proposal below has been superseded. LangChain now provides the planner internals via a
> `Runnable` chain (`ChatPromptTemplate | LLM | StructuredOutputParser`), replacing manual prompt
> construction and output parsing. Concretely: `ChatAnthropic` / `ChatOpenAI` (packages
> `langchain-anthropic`, `langchain-openai`) replace the bespoke hosted-backend implementation;
> `ChatOllama` (package `langchain-community`) replaces the bespoke Ollama backend; LangChain's
> native `.with_fallbacks([ChatOllama(...)])` replaces the manual try/catch retry logic. The call
> site changes from `backend.generate_plan(context)` to `chain.invoke(context_dict)`. Structured
> output is parsed via `.with_structured_output(OptimizerPlan)`, with `OptimizerPlan` remaining a
> Pydantic model. Everything outside the planner boundary is unchanged — the five
> invocation-strategy levers and their values, `PlanContext`, the constraint validation layer,
> configuration structure, and all other RFCs. The Proposal and its Alternatives are retained as the
> deliberation record. See ADR entry 2026-06-11.

> **Revision (2026-07-09 — supersedes the primary/fallback default below):** The **default** planning
> backend is now the **local Ollama** model, not a hosted API. The interface stays backend-agnostic and
> provider-selectable: `provider` defaults to `"ollama"` (offline, no API key, no data egress), with
> `"anthropic"` / `"openai"` available as **opt-in cloud backends** for higher-capability planning. The
> hosted→Ollama fallback topology of the original Proposal becomes **optional and configurable**
> (`fallback_provider`, empty by default) rather than a fixed hosted-primary arrangement — with a local
> primary, the always-available `ollama` container is itself the backstop, so no fallback is required by
> default; one is typically configured only when a *cloud* provider is the primary. Rationale: `P3-PORT-1`
> (no cloud account) holds out of the box, planning is free and fully offline by default, and the cloud
> path is one config change away. The invocation strategy, `PlanContext`, constraint validation, and all
> other RFCs are unchanged. See ADR entry 2026-07-09.

### Summary

Define a **backend-agnostic LLM interface** in the Python optimizer. Use a **hosted LLM**
(Anthropic or OpenAI) as the primary planning backend, with **Ollama** as the local fallback when
the hosted backend is unavailable or unconfigured. A single **backend-agnostic invocation strategy**
— fixed token budget, hourly telemetry summaries, adaptive horizon, state-change gate, and fixed
cycle cadence — governs all LLM calls regardless of which backend is active.

### Problem

The optimizer (Phase 3) uses an LLM to generate refined setpoint plans from simulation state and constraints.
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
  generate_plan(context: PlanContext) -> OptimizerPlan
```

`PlanContext` carries the digital-twin simulation state, current setpoints, crop-safe bounds, and
cost/time-of-use signals. `OptimizerPlan` carries refined setpoints and a reasoning trace for audit.

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
generates a plan, regardless of which backend produced it. No optimizer plan reaches the controller
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
  ([P1 §3](../specs/design/controller/03-spec-controller-hal-simulation.md)), not in the control
  loops. The PIDs target *variables*, not actuators, so the actuator→variable cardinality never
  reaches the rule engine or PID wiring. Deciding *which* coupled actuator to use when several affect
  one variable is the Phase 4 actuator-selection layer — explicitly deferred, and additive above the
  unchanged loops.

### Resolution

**Accepted 2026-06-07 — implement Phases 1–3 to spec, with the single constraint that the Phase 1
HAL actuator interface must not encode "one actuator → one climate variable" as an invariant.** No
combustion code, weather feed, or actuator-selection logic lands before Phase 4. See ADR entry
2026-06-07.

---

## RFC-007: Contract Conventions (MQTT topics, identity, payload envelope, schema format)

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-07 |
| Priority | Highest — blocks contract implementation for all three phases |

### Summary

Establish the conventions that govern [`contracts/`](../../contracts/) before any schema file is
written: (1) the **MQTT topic taxonomy** and the **canonical identity scheme** (`greenhouse_id` /
`zone_id`) shared across MQTT topics, REST paths, and DB keys; (2) a **common payload envelope** with
a fixed timestamp format and units convention; and (3) the **schema format** (JSON Schema, Draft
2020-12) and a **versioning rule**. Also resolves a standing doc inconsistency: **MQTT carries
telemetry only** — it is not a command/setpoint channel (setpoints flow over REST per
[RFC-005](#rfc-005-setpoint-authority-and-delivery-chain)).

### Problem

Every design doc explicitly defers wire formats to `contracts/` — the controller spec
([§11](../specs/design/controller/08-spec-controller-interfaces.md)), the platform spec
([overview](../specs/design/platform/01-spec-platform-overview.md)), the optimizer spec, and the Phase 4 spec all say
"topic names, payload schemas, REST shapes … live in `contracts/`." But `contracts/` is the single
source of truth that **all three phases conform to**, and no RFC has settled its shape. RFCs 001–006
each picked a *component* (broker, store, ingress, LLM backend, setpoint authority, Phase 4 seam);
none designed the cross-phase wire contract itself — the highest-blast-radius artifact in the system,
since changing it later means editing Rust, Go, and Python at once.

Three decisions block writing the first schema:

1. **Topic taxonomy & identity.** [04-spec-platform-ingestion.md](../specs/design/platform/04-spec-platform-ingestion.md#2-per-greenhouse-routing)
   already assumes "each controller publishes under its own topic root … maps topic → greenhouse via
   the registry," but the root structure and the ID format are undecided. The same identity has to key
   MQTT topics, REST paths (`/greenhouses/{id}/setpoints`, RFC-005), and the registry/telemetry rows
   (RFC-002).
2. **Payload envelope.** Timestamp format, units, and a `schema_version` field need to be uniform so a
   multi-greenhouse ingester can self-describe every message.
3. **Schema format & versioning.** `contracts/README.md` lists "JSON Schema / AsyncAPI" (undecided)
   and says changes "should be versioned" with no scheme.

A standing inconsistency also needs resolving: post-RFC-005 the controller is setpoint-only and
setpoints arrive via REST, yet `contracts/README.md`, [high-level-idea.md](../specs/design/high-level-idea.md)
and [08-spec-controller-interfaces.md](../specs/design/controller/08-spec-controller-interfaces.md) still
describe MQTT actuator-command/plan topics. This RFC fixes the docs to match the decision.

### Proposal

**1. Identity scheme**

| Field | Type | Rule |
|---|---|---|
| `greenhouse_id` | string | Stable lowercase kebab slug (e.g. `gh-a`, `lettuce-north`). Matches the named, config-generated Compose services from [RFC-003](#rfc-003-phase-2-platform-ingress) — not opaque UUIDs. Unique site-wide (single site, per spec). |
| `zone_id` | string | Lowercase kebab slug, unique **within** a greenhouse (e.g. `zone-1`). |

The same `greenhouse_id` / `zone_id` are the keys in MQTT topics, REST paths, and DB rows — one
identity, no translation layer.

**2. MQTT topic taxonomy** (all publish from the controller — telemetry up; see §4)

```
gh/{greenhouse_id}/sensor/{metric}                        # greenhouse-scoped sensor (e.g. co2, humidity)
gh/{greenhouse_id}/zone/{zone_id}/sensor/{metric}         # zone-scoped sensor (e.g. soil_moisture, par)
gh/{greenhouse_id}/actuator/{actuator}/state              # greenhouse-scoped actuator state
gh/{greenhouse_id}/zone/{zone_id}/actuator/{actuator}/state
gh/{greenhouse_id}/fault                                  # fault events
gh/{greenhouse_id}/state                                  # consolidated last-known system state (RETAINED)
```

- Hierarchical so the ingester can wildcard-subscribe per greenhouse (`gh/+/#`) or per metric.
- **QoS 1** for all telemetry; **retained** on the consolidated `gh/{id}/state` topic only, so a
  subscriber has current state on connect (per [RFC-001](#rfc-001-mqtt-broker-selection)).
- Greenhouse-scoped vs zone-scoped split mirrors the physical model (CO₂/humidity are house-level;
  soil moisture / PAR are per-zone).

**3. Payload envelope** (every message)

| Field | Type | Notes |
|---|---|---|
| `schema_version` | integer | Major version of the message schema (see §5). |
| `greenhouse_id` | string | Redundant with topic; lets ingested rows stand alone. |
| `zone_id` | string \| null | Present for zone-scoped messages. |
| `ts` | string | RFC 3339 / ISO 8601, UTC, millisecond precision (e.g. `2026-06-07T14:03:00.000Z`). |
| *(message-specific)* | — | e.g. `value` + `unit` for a sensor reading; `state` for an actuator. |

**Units convention** (carried explicitly in payloads, single source here):

| Quantity | Unit |
|---|---|
| Temperature | °C |
| Relative humidity | %RH |
| CO₂ | ppm |
| Soil moisture | %VWC |
| PAR | µmol·m⁻²·s⁻¹ |
| VPD | kPa |

**4. MQTT is telemetry-only.** The controller **publishes** sensor readings, actuator state, fault
events, and consolidated system state; it **subscribes to nothing**. Setpoints reach the controller
over its REST config API, with Phase 2 as the single authority
([RFC-005](#rfc-005-setpoint-authority-and-delivery-chain)). There are no command/plan topics. The
stale references in `contracts/README.md`, `high-level-idea.md`, and `spec-climate-controller.md §11`
are corrected to match.

**5. Schema format & versioning**

- **JSON Schema (Draft 2020-12)** is the normative artifact: one schema file per message type under
  `contracts/mqtt/`. Directly consumable for validation in all three stacks (Rust, Go, Python) with no
  intermediate tooling. AsyncAPI may later wrap these schemas as a documentation layer without
  becoming the source of truth.
- **Versioning:** `schema_version` is an **integer major**. Additive, backward-compatible changes (a
  new optional field) do **not** bump it. Breaking changes bump the major; the previous major's schema
  is retained side-by-side during transition. Every contract change is accompanied by an ADR, per
  `contracts/README.md`.

### Alternatives Considered

**Flat topic namespace** (e.g. `sensor_temp_gh_a`) — rejected: defeats per-greenhouse / per-zone
wildcard subscription, which the ingester relies on.

**UUID identities** — rejected for a local, single-site portfolio system: opaque and hard to debug,
and they don't align with the named, config-generated controller services from RFC-003. Slugs are
human-readable in topics, logs, and the MQTT tree.

**AsyncAPI as the normative contract** — rejected: heavier to author and maintain, and validation
still comes from the JSON Schema it embeds. JSON Schema first; AsyncAPI optional later as docs.

**Bare values, no envelope** — rejected: loses the self-description (version, timestamp, identity,
units) a multi-greenhouse ingester needs to attribute and validate each message independently.

**Command/plan topics over MQTT** — rejected: contradicts RFC-005, which makes REST the sole setpoint
path and Phase 2 the single authority. A second write path over MQTT would re-introduce exactly the
split authority RFC-005 eliminated.

### Open Questions

- Closed enumerations vs open strings for `{metric}` and `{actuator}` names — lean toward an
  enumerated closed list in the schemas; finalize while authoring them.
- Whether to additionally retain the last value on each per-sensor topic, or rely solely on the
  consolidated retained `state` topic. Default: consolidated `state` only.
- `schema_version` as a single integer (this proposal) vs full semver — integer chosen for
  simplicity; revisit only if minor-version negotiation is ever needed.

### Resolution

**Accepted 2026-06-07 — contract conventions fixed before schema authoring.** The canonical identity
is the `greenhouse_id` / `zone_id` kebab-slug pair, shared verbatim across MQTT topics, REST paths,
and DB rows. MQTT uses the hierarchical `gh/{greenhouse_id}/...` taxonomy and is **telemetry-only**
(setpoints flow over REST per RFC-005). Every message carries the common envelope
(`schema_version`, `greenhouse_id`, `zone_id`, `ts` in RFC 3339 UTC) and the units convention.
Schemas are authored as **JSON Schema (Draft 2020-12)** under `contracts/mqtt/`, versioned by an
integer `schema_version` major (additive changes do not bump). See ADR entry 2026-06-07.

---

## RFC-008: Phase 3 Telemetry Read Path

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-07 |
| Decided | 2026-06-08 |
| Priority | Medium — blocks Phase 3 data-access implementation |

> **Revision (2026-07-07):** The accepted direct-DB resolution below has been revised by
> [ADR 2026-07-07](./architecture-design-record.md#2026-07-07--phase-3-telemetry-read-path-revised-platform-rest-api-backed-by-internal-sql-views).
> The optimizer now consumes a **Phase 2 REST telemetry read API**. SQL views and TimescaleDB
> continuous aggregates remain allowed, but only as platform-internal implementation details behind
> that REST handler, not as the cross-service contract and not as a direct optimizer connection.

### Summary

Ratify the optimizer's **direct, read-only access to Phase 2's TimescaleDB** as the telemetry read
path, but contain the resulting schema coupling: the optimizer connects with a **dedicated read-only
role** whose grants are limited to a **defined read surface** (a small set of stable telemetry
**views**, not the raw tables), and that read surface is treated as a **versioned contract** Phase 2
may not break silently — the same discipline [RFC-007](#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
applies to the wire contract, applied here to the read schema.

### Problem

[RFC-005](#rfc-005-setpoint-authority-and-delivery-chain) settled how setpoints are **written** — only
through the Phase 2 API, never around it — so that bounds enforcement and provenance live in one
place. The optimizer's **read** path does the opposite, and no RFC has examined it:

- [09-spec-optimizer-interfaces.md](../specs/design/optimizer/09-spec-optimizer-interfaces.md)
  lists "TimescaleDB | Phase 2 store → optimizer | Read-only historical telemetry."
- [10-spec-optimizer-configuration.md](../specs/design/optimizer/10-spec-optimizer-configuration.md) configures
  it as a raw DSN: `postgres_dsn = "postgresql://optimizer:***@platform-db:5432/greenhouse"  # read-only`.

So Phase 3 reaches **into Phase 2's database directly** rather than through Phase 2's API. This is the
classic *shared-database* vs. *API-composition* integration choice, and it is currently **asserted,
not decided**. Its cost is real: a direct dependency on Phase 2's internal telemetry schema means a
Phase 2 migration (renamed column, changed hypertable layout, altered retention) can break the
optimizer with **no contract between them** — exactly the cross-codebase blast radius RFC-007 was
created to prevent for the wire formats.

The read path is also genuinely different from the write path RFC-005 governed: a read carries **no
authority and no safety concern** (it cannot drive the greenhouse to an unsafe state), and the
optimizer's workload — range scans over high-volume time-series plus the hourly `(min, mean, max)`
summaries from [RFC-004](#rfc-004-phase-3-llm-integration-interface) — is precisely what
TimescaleDB's SQL and continuous aggregates do well and what a REST layer would have to re-expose.

### Proposal

**Keep the direct read, contain the coupling.** Three parts:

1. **Dedicated read-only role.** The optimizer connects as a Postgres role (`optimizer_ro`) with
   `SELECT`-only grants. It has **no** access to the relational write tables (registry, crop profiles,
   assignments, users) beyond what the read surface exposes, and no `INSERT/UPDATE/DELETE` anywhere.
   The role is the enforcement that "read-only" is a guarantee, not a convention in a comment.

2. **A defined read surface, exposed as views.** The optimizer reads from a small set of **named
   views** owned by Phase 2 — e.g. `optimizer_sensor_readings`, `optimizer_actuator_states`,
   `optimizer_current_setpoints` — not from the physical hypertables directly. The views are the
   contract boundary: Phase 2 may refactor the underlying tables freely as long as it preserves the
   views. The optimizer's grants are on the views only.

3. **The read surface is versioned like a contract.** A breaking change to a view's shape is an ADR
   event and follows the RFC-007 discipline (additive change is free; a breaking change is announced,
   and the previous shape is retained side-by-side during transition). This gives Phase 3 the same
   stability guarantee against Phase 2's schema that all three phases already have against the MQTT
   wire contract.

The hourly-summary serialization ([RFC-004](#rfc-004-phase-3-llm-integration-interface)) can be backed
by a **TimescaleDB continuous aggregate** exposed through the read surface, so the summarization the
LLM-context strategy needs is computed in the store rather than pulled raw and reduced in Python.

The write path is unchanged: refined setpoints still go **only** through the Phase 2 API per RFC-005.
This RFC governs reads exclusively.

### Alternatives Considered

**Read through a Phase 2 REST query API** — the optimizer fetches history via Phase 2 HTTP endpoints
instead of SQL, fully decoupling it from the physical schema. Rejected as the committed path because
it forces Phase 2 to build and maintain a range/aggregation query API whose only consumer is one
internal service, re-implements over HTTP what TimescaleDB already does in SQL (windowed aggregates,
time-bucketing), and serializes potentially large history payloads through JSON for bulk reads. The
view-based read surface achieves most of the decoupling (the physical tables stay private) at a
fraction of the cost, and can be promoted to a REST API later if a second external consumer appears.

**Replicate telemetry into a Phase 3-owned store** — the optimizer subscribes to MQTT (or a Phase 2
feed) and maintains its own copy. Rejected: it duplicates the time-series storage and retention
problem RFC-002 already solved in Phase 2, and adds a sync/consistency burden for a read workload that
a `SELECT` against the existing store handles directly.

**Raw-table access, no read surface** (the status quo in the spec text) — simplest to wire up.
Rejected as the *committed* form because it is the uncontained version of this same decision: it leaves
Phase 3 bolted to Phase 2's physical schema with no boundary, which is the coupling this RFC exists to
bound. Granting on views instead of tables is a near-zero-cost change that buys the boundary.

### Open Questions

- Exactly which views constitute the read surface, and whether current setpoints are best read from a
  view here or fetched from the Phase 2 API (they are small and authority-bearing — the API may be the
  cleaner source for *current* intended state, leaving the DB read surface to **historical** telemetry
  only). Lean: history from the read surface, current setpoints from the Phase 2 API.
- Same Postgres instance vs. a read replica. Default: same instance (local, single-machine — a replica
  is unjustified at this scale); revisit only if optimizer read load measurably affects platform write
  latency.
- Whether the hourly summary should be a TimescaleDB continuous aggregate (precomputed, refreshed) or
  an on-demand `time_bucket` query. Tie-break during implementation against the actual cycle cadence
  from RFC-004.

### Resolution

**Accepted 2026-06-08 — direct read-only access to Phase 2's TimescaleDB, with the coupling contained
by a versioned view-based read surface.** The optimizer connects as a dedicated `optimizer_ro` role
with `SELECT`-only grants on a small set of named telemetry **views** owned by Phase 2 (not the raw
hypertables) — no access to the relational write tables, no write grants anywhere. The views are the
contract boundary: Phase 2 may refactor the physical tables freely as long as it preserves the views,
and a breaking change to a view's shape is an ADR event following the same RFC-007 discipline as the
wire contract (additive is free; breaking is announced and the previous shape retained side-by-side
during transition). The hourly `(min, mean, max)` summaries from RFC-004 may be backed by a
TimescaleDB continuous aggregate exposed through the read surface. The write path is unchanged —
setpoints still go only through the Phase 2 API per RFC-005; this RFC governs reads exclusively. The
open questions (exact view set, current-setpoints-via-view-vs-API, same-instance-vs-replica,
continuous-aggregate-vs-on-demand) are implementation tuning, not blockers. See ADR entry 2026-06-08.

---

## RFC-009: Service-to-Service Auth & Internal Trust Boundaries

| Field   | Value |
|---------|-------|
| Status  | **Superseded** by [RFC-011](#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) (2026-06-21) |
| Created | 2026-06-07 |
| Decided | 2026-06-08 |
| Priority | Medium — blocks the Phase 3 write path and managed-mode controller hardening |

> **Superseded (2026-06-21):** [RFC-011](#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)
> reopens this decision and **reverses** the human-only Resolution below: both internal write boundaries
> now gain authentication, shipped as a **config-gated mode that is off by default** in the single-host
> local deployment. RFC-011 re-adopts this RFC's original *Proposal* (the Keycloak client-credentials
> grant + per-controller bearer token) and resolves its open question toward a **narrow service role**.
> This RFC is retained in full as the deliberation record; the "human-only" stance it accepted is **no
> longer the committed posture**.

> **Decision (2026-06-08 — diverges from the Proposal below):** The system authenticates **human
> actors only**. The non-human, service-to-service boundaries are **not** authenticated; they rely on
> the trusted local Docker Compose network. Concretely: **no controller-side auth** (the
> platform→controller REST link is protected by Docker network isolation alone, not a token), and the
> optimizer→Phase 2 API write path is trusted on the internal network rather than carrying a Keycloak
> service-account token. The Proposal below (Keycloak service-account client-credentials grant +
> per-controller pre-shared bearer token) was considered and **not adopted** — see [Resolution](#resolution-8).
> The Proposal and its Alternatives are retained as the deliberation record.

### Summary

Define authentication for the system's **non-human, service-to-service** boundaries, which no RFC has
settled. Three boundaries exist: (1) **optimizer → Phase 2 API** — a headless write-path client that
needs the operator capability; (2) **platform → controller REST** — the only inbound write path into a
controller, currently unauthenticated; (3) **optimizer → Phase 2 DB** — covered by
[RFC-008](#rfc-008-phase-3-telemetry-read-path)'s read-only role. Proposal: the optimizer authenticates
to the Phase 2 API as a **Keycloak service account via the OAuth2 client-credentials grant** mapped to
the operator role; the platform authenticates to each controller's REST API with a **per-controller
bearer token** (no OIDC in the controller); MQTT stays anonymous on the local network per
[RFC-001](#rfc-001-mqtt-broker-selection).

### Problem

The platform's authorization model is specified for **humans** but not for **services**:

- [09-spec-platform-interfaces.md](../specs/design/platform/09-spec-platform-interfaces.md#5-authorization) and
  [authentication](../specs/design/platform/07-spec-platform-security.md): write-path actions
  (assignments, setpoint edits) "require the **operator** role," carried in a Keycloak **OIDC token**.
- But [05-spec-optimizer-constraints-and-application.md §2](../specs/design/optimizer/05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
  makes the optimizer a write-path client — `POST /greenhouses/{id}/setpoints` — with **no statement
  of how a headless service obtains an operator token**. Keycloak's interactive login flow assumes a
  human at a browser; the optimizer has neither.

Separately, the **controller's** REST API is unauthenticated:

- [08-spec-controller-interfaces.md](../specs/design/controller/08-spec-controller-interfaces.md) describes
  the REST config/override API with no auth. Standalone ([P1 §13](../specs/design/controller/02-spec-controller-architecture.md#8-deployment))
  that is fine — it is a local dev binary. But in **managed mode** the platform pushes setpoints to it
  over the Docker network ([P2 interfaces](../specs/design/platform/09-spec-platform-interfaces.md)),
  and that REST surface is the **only inbound write path into the greenhouse** — currently anyone on
  the Compose network can drive it. Whether that boundary is authenticated, and how, is an unstated
  decision with real (if local) blast radius: it touches the controller (Rust), the platform's
  outbound client, and the registry's controller-endpoint record.

These are decided together because they are the system's internal trust model, and the right answer
for each depends on the others (a single Keycloak posture, a single statement of what is trusted on
the Docker network).

### Proposal

**1. Optimizer → Phase 2 API: Keycloak service account (client-credentials grant).**

Register the optimizer as a **confidential OAuth2 client** in Keycloak (client id `optimizer`) with a
**client-credentials** grant — the standard machine-to-machine flow, no browser, no human. Keycloak
issues an access token carrying a client role that the API maps onto the platform **operator** role,
so the optimizer authenticates and authorizes through the *same* token-validation path RFC-005 and
[authentication](../specs/design/platform/07-spec-platform-security.md) already define for human
operators — no second authz mechanism. Provenance is unaffected: the setpoint write is still recorded
with source `optimizer` (RFC-005), now backed by a verifiable client identity rather than an
anonymous call. The client secret is supplied via environment variable / Compose secret
(`PLANNER_*`-style), never in a committed file, consistent with
[10-spec-optimizer-configuration.md](../specs/design/optimizer/10-spec-optimizer-configuration.md).

**2. Platform → controller REST: per-controller bearer token.**

Each controller is provisioned with a **pre-shared bearer token** in its TOML
([P1 §4](../specs/design/controller/07-spec-controller-config-and-parameters.md)); the controller
requires it on the REST config/override/health-write endpoints and rejects unauthenticated calls. The
platform stores the matching token in the **registry's controller-endpoint record**
([P2 fleet management](../specs/design/platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control)) and presents
it on every downward REST call. This authenticates the *only* inbound write path into a controller
without putting an OIDC client in the lightweight Rust process — Keycloak/OIDC in the controller would
be disproportionate for a single trusted caller (the platform). Standalone Phase 1 leaves the token
unset and the check disabled, preserving the zero-friction local-dev binary
([P1 §13](../specs/design/controller/02-spec-controller-architecture.md#8-deployment)).

**3. Optimizer → Phase 2 DB:** the read-only `optimizer_ro` role from
[RFC-008](#rfc-008-phase-3-telemetry-read-path). No additional mechanism here; listed so the three
internal boundaries are stated in one place.

**4. MQTT:** stays **anonymous** on the local Compose network per
[RFC-001](#rfc-001-mqtt-broker-selection). MQTT is telemetry-only
([RFC-007](#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)) — it
carries no command authority, so it is not a write boundary, and broker auth/ACLs remain the deferred
item RFC-001 already flagged. This RFC does not change that.

**Trust-boundary summary:**

| Boundary | Direction | Mechanism |
|---|---|---|
| Optimizer → Phase 2 API | write (setpoints) | Keycloak service account, client-credentials grant → operator role |
| Platform → controller REST | write (setpoints/override) | Per-controller pre-shared bearer token (registry ↔ TOML) |
| Optimizer → Phase 2 DB | read (history) | Read-only `optimizer_ro` role ([RFC-008](#rfc-008-phase-3-telemetry-read-path)) |
| Any → MQTT broker | telemetry only | Anonymous on local network ([RFC-001](#rfc-001-mqtt-broker-selection)) |

### Alternatives Considered

**Optimizer uses a static API key / shared secret against the Phase 2 API** (not Keycloak) — simpler,
no Keycloak client registration. Rejected because it introduces a *second* authn/authz path alongside
the OIDC one the platform already runs, splitting the trust model. The client-credentials grant reuses
Keycloak — which is already in the stack for human auth — so the API validates one kind of token.

**OIDC/Keycloak client in the controller too** (symmetric with the optimizer) — uniform mechanism
everywhere. Rejected: the controller is a deliberately minimal Rust process with exactly one trusted
caller (the platform); a full OIDC relying-party implementation and token refresh in the controller is
disproportionate to a single point-to-point link on a local network. A pre-shared bearer token is the
right weight for that boundary.

**No controller-side auth — rely on Docker network isolation alone** — the status quo. Rejected as the
committed posture because the controller REST API is the only inbound write path into the greenhouse;
leaving it open means any container (or any process that can reach the published port in dev) can push
setpoints. The bearer token is cheap and makes the platform the demonstrable sole writer, matching the
single-authority intent of RFC-005 at the transport level.

**mTLS between all internal services** — strongest, certificate-based mutual auth. Rejected as
over-scoped for a local, single-machine portfolio system: it adds a certificate-issuance and rotation
burden (a local CA, per-service certs) far beyond what the threat model of a Docker Compose stack on
one laptop warrants. The token-based boundaries above are proportionate; mTLS can be revisited if the
system ever leaves the single-host local model.

### Open Questions

- Token rotation for the per-controller bearer token: static-for-the-lifetime-of-the-deployment is
  almost certainly fine locally, but the generation script
  ([P2 deployment](../specs/design/platform/08-spec-platform-operations.md#2-deployment)) is the natural place to mint one
  per controller if rotation is ever wanted. Default: static, set at provisioning.
- Whether the optimizer's Keycloak client role should be the full **operator** role or a narrower
  **service** role scoped to just `POST /setpoints` (operator can also assign profiles, which the
  optimizer never does). Lean toward a narrow service role — least privilege — finalized when the
  Keycloak realm is configured.
- Whether to also require the bearer token on the controller's **read** (status/health) endpoints or
  only on write endpoints. Default: writes only; reads are low-risk and the platform polls them
  frequently.

### Resolution

**Accepted 2026-06-08 — no service-to-service authentication; the local Docker network is the trust
boundary and authentication is human-only. This adopts an alternative, not the Proposal above.** The
proposed mechanisms (a Keycloak service-account client-credentials grant for the optimizer and a
per-controller pre-shared bearer token) are **not** adopted. The committed posture:

| Boundary | Direction | Mechanism (accepted) |
|---|---|---|
| Human operator → Phase 2 API/SPA | write + read | **Keycloak OIDC** — unchanged from [P2 authentication](../specs/design/platform/07-spec-platform-security.md). The only authenticated boundary. |
| Optimizer → Phase 2 API | write (setpoints) | **None** — trusted on the internal Docker network; the Phase 2 write endpoints accept the internal call without a service token. |
| Platform → controller REST | write (setpoints/override) | **None** — Docker network isolation alone; the controller REST API stays unauthenticated in managed mode exactly as in standalone ([P1 §11](../specs/design/controller/08-spec-controller-interfaces.md), [§13](../specs/design/controller/02-spec-controller-architecture.md#8-deployment)). |
| Optimizer → Phase 2 DB | read (history) | Read-only `optimizer_ro` role ([RFC-008](#rfc-008-phase-3-telemetry-read-path)) — a least-privilege **database** credential, not service authn; unchanged. |
| Any → MQTT broker | telemetry only | Anonymous on the local network ([RFC-001](#rfc-001-mqtt-broker-selection)) — unchanged. |

**Why the Proposal was not adopted.** The threat model is a single-machine, local Docker Compose
portfolio system. Within that one host the network *is* the trust boundary, so adding service-credential
machinery — Keycloak client registration plus token acquisition/refresh in the optimizer, and
per-controller token generation, registry storage, and TOML provisioning for the controller — is
operational surface disproportionate to a one-laptop deployment. That is the same reasoning the
Proposal itself used to reject mTLS; applied consistently, it rejects the token mechanisms too. Keeping
authentication **human-only** preserves a single auth concept (Keycloak OIDC for people) and avoids
standing up a second authn path for services.

**Costs accepted explicitly.** Any process that can reach a service on the Docker network (or a
published port in dev) can call the controller REST API or the Phase 2 setpoint endpoint — this is the
open inbound write path the Proposal's bearer token was meant to close, and it is accepted here as
within the local threat model. Setpoint provenance (`source = optimizer`, [RFC-005](#rfc-005-setpoint-authority-and-delivery-chain))
is still recorded by the application but is **self-asserted** by the caller rather than backed by a
verified token identity. The controller's REST API ([P1 §11](../specs/design/controller/08-spec-controller-interfaces.md))
and the registry's controller-endpoint record ([P2 fleet management](../specs/design/platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control))
remain the natural seams to add a per-controller token, and the optimizer the natural place to add a
service account, **if** the system ever leaves the single-host local model. The Proposal's open
questions (token rotation, narrow service role vs. operator, auth on read endpoints) are moot under
this decision. See ADR entry 2026-06-08.

---

## RFC-010: Verification & Continuous-Integration Strategy

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-18 |
| Decided | 2026-06-18 |
| Priority | Medium — gates the transition from spec to Phase 1 implementation |

> **Decision (2026-06-18):** Adopt a single, system-wide verification strategy with two homes — a
> cross-cutting [`spec-verification.md`](../specs/design/spec-verification.md) (the verification
> ladder, the feedback-loop ladder, the tooling matrix, the CI plan) plus per-component verification
> docs deferring to it (the optimizer's
> [`07`](../specs/design/optimizer/07-spec-optimizer-evaluation.md) and the controller's
> [`11`](../specs/design/controller/11-spec-controller-verification.md) are the first two). Wire the
> **contract-validation harness now** — it runs locally and needs no CI. Defer the **CI pipeline**
> until a platform is adopted. The tooling decision is recorded in
> [`local-environment-record.md`](./local-environment-record.md).

### Summary

The system had quality *targets* (the `*-TEST-*` / `*-PERF-*` IDs in the
[NFR doc](../specs/artifacts/non-functional-requirements.md)) and one component-level verification
*strategy* (optimizer [`07`](../specs/design/optimizer/07-spec-optimizer-evaluation.md)), but no
system-wide statement of **how the system is verified**, **what the development feedback loops are**,
or **what tooling is required** — the open `research/todo.md` item "Identify code verification and
feedback loops." This RFC settles that strategy and wires the one piece that did not depend on
infrastructure the repo lacks: the contract-validation harness.

### Problem

Verification was scattered and partly aspirational:

- The contract READMEs each specified an Ajv/Redocly fixture check but called it a **manual** step
  with "no committed harness or CI yet"; [`docs/backlog.md`](../backlog.md) tracked it as blocked on
  CI. Nothing re-ran the check, so a schema regression or a drifted fixture would pass unnoticed.
- Only the local [`.githooks/pre-commit`](../../.githooks/pre-commit) Rust gate existed; there was no
  named ladder of feedback loops, no per-language tooling matrix, and no CI definition.
- "Feedback loop" is ambiguous in a control-systems project — the runtime sensor→actuator control
  loop versus the development loops that prove a change correct.

### Proposal

1. **Two-home verification spec.** A cross-cutting
   [`spec-verification.md`](../specs/design/spec-verification.md) owns the system-wide story
   (verification ladder, the development-feedback-loop ladder explicitly distinguished from the
   control loop, the tooling matrix, the deferred CI topology, and the contract harness). Each spec
   set carries (or will carry, as it approaches implementation) a per-component verification doc that
   defers to it — controller `11` now, platform/frontend later.
2. **Wire the contract harness now.** [`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs)
   (`npm run validate:contracts`) validates every contract's schemas + example fixtures with Ajv
   (Draft 2020-12) and lints the OpenAPI documents with `@redocly/cli`; it runs in a pre-commit
   contracts gate scoped to staged contract paths. `@redocly/cli` is added as a **pinned
   devDependency** — the linter the OpenAPI READMEs already mandate. No runtime dependency is added.
3. **Defer CI.** A clean-environment pipeline (Rust gate, contract harness, coverage, and the
   Go/Python/frontend gates as they land) is the plan of record but waits for a CI platform; it stays
   the open item in [`docs/backlog.md`](../backlog.md).

### What this adopts now vs. defers

- **Adopted now:** the verification/feedback-loop strategy docs; the wired contract harness + pre-commit
  contracts gate; the filled-in dev-command entries in the root README.
- **Deferred:** the CI pipeline; per-component verification docs for the platform and frontend;
  `cargo llvm-cov` coverage enforcement and the Go/Python/frontend/load tooling — each lands with the
  phase it verifies.

### Alternatives Considered

- **Fold everything into the NFR doc.** Rejected: the NFR doc owns *targets* (a single source of
  truth for numbers); mixing the *strategy* and tooling into it would blur that boundary and break the
  symmetry the optimizer set already established with `07`.
- **One monolithic verification doc, no per-component docs.** Rejected: it breaks the per-set
  structure and would force the controller/platform/frontend scenario detail into a doc that also
  carries cross-cutting concerns.
- **Build CI now.** Out of scope by choice — no CI platform is adopted, and the harness runs locally
  without one. Building it now would front-run that decision.
- **`check-jsonschema` (Python) for the harness instead of an Ajv/Node script.** Rejected: `ajv` is
  already a repo dependency and the OpenAPI lint needs Redocly (Node) regardless; one Node harness is
  simpler than adding a Python toolchain purely for validation.

### Resolution

Accepted as the decision above. The strategy lives in
[`spec-verification.md`](../specs/design/spec-verification.md); the tooling choice (Ajv + pinned
Redocly, the `npm` script, the pre-commit gate) is recorded in
[`local-environment-record.md`](./local-environment-record.md); the remaining CI-pipeline work is the
open item in [`docs/backlog.md`](../backlog.md).

**Update (2026-06-22):** the deferred CI pipeline landed. GitHub Actions
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) is the adopted platform; it re-runs
the Rust gate and the contract harness in a clean environment on push/PR — the gates the pre-commit
hook fires locally. Coverage enforcement (`cargo llvm-cov` vs `P1-TEST-1`) and the per-phase
Go/Python/frontend/load gates remain per the [tooling matrix](../specs/design/spec-verification.md#4-tooling-matrix),
now tracked by the narrowed item in [`docs/backlog.md`](../backlog.md). Platform-adoption rationale:
[`local-environment-record.md` 2026-06-22](./local-environment-record.md).

---

## RFC-011: Service-to-Service Auth as a Config-Gated Hardening Mode (supersedes RFC-009)

| Field   | Value |
|---------|-------|
| Status  | Accepted |
| Created | 2026-06-21 |
| Decided | 2026-06-21 |
| Supersedes | [RFC-009](#rfc-009-service-to-service-auth--internal-trust-boundaries) |
| Priority | Medium — establishes the cloud/multi-host posture without disturbing the local MVP |

> **Decision (2026-06-21 — reopens and reverses [RFC-009](#rfc-009-service-to-service-auth--internal-trust-boundaries)):**
> Adopt authentication on the two internal **write** boundaries RFC-009 left trusted, but ship it as a
> **config-gated hardening mode that is off by default in the single-host local deployment**. Two
> independent, deferred mechanisms are reserved and specified now so that enabling them later is a
> **configuration change, not an interface change**: (1) the optimizer authenticates to the Phase 2 API
> with a **Keycloak client-credentials** token carrying a narrow `setpoints:write` service role, gated by
> a Phase 2 `SERVICE_AUTH_MODE` switch (`trusted_network` default | `oidc`); (2) the platform presents a
> **per-controller pre-shared bearer token** on the controller REST write path, presence-gated (unset =
> disabled = today's behavior). This re-adopts RFC-009's original *Proposal* — which RFC-009's
> Resolution rejected — and resolves its open question in favor of a **narrow service role** over the
> full operator role. RFC-009 is retained as the deliberation record and marked **Superseded**.

### Summary

RFC-009 settled the internal trust model as **human-only authentication**: the optimizer → Phase 2 API
and platform → controller REST write paths are trusted on the local Docker network, with no service
credentials. That decision was correct *for a single-host laptop deployment* and is what the MVP still
ships. This RFC does not contradict that economy — it **reopens the decision** to make the system
**cloud-ready**: the moment the stack spans more than one host, "the network is the trust boundary"
stops holding, and RFC-009 itself named the optimizer service account and the controller-endpoint
registry record as the seams to add auth *if the system ever leaves the single-host model*. Rather than
leave that as prose to be rediscovered, this RFC specifies both seams now as an **explicit, off-by-default
mode**, so the upgrade is a config flip with no change to the committed setpoint contract.

### Problem / Context

The accepted RFC-009 posture has a documented residual risk
([P2 security §5](../specs/design/platform/07-spec-platform-security.md#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode)):
any process that can reach the Docker network can call the controller REST setpoint path or the
platform's `POST /setpoints`, and setpoint provenance (`source = optimizer`,
[RFC-005](#rfc-005-setpoint-authority-and-delivery-chain)) is **self-asserted** rather than backed by a
verified identity. RFC-009 accepted this *within the single-host local threat model* and stated the
revisit trigger explicitly. The operator has chosen to **plan the hardening now** — not to burden the
local MVP, but to keep the architecture pointed at a real cloud posture. The requirement is therefore:
adopt the auth path in the specs and the config surface, but keep it **dormant by default** so the
one-laptop deployment carries none of the operational weight until it opts in.

### Decision

**1. Optimizer → Phase 2 API — Keycloak client-credentials, config-gated.**

Reserve the optimizer as a **confidential Keycloak client** (`client_id: optimizer`) using the OAuth2
**client-credentials** grant — the standard machine-to-machine flow, no browser. Keycloak issues an
access token carrying a **narrow service role**, `setpoints:write`, that the Phase 2 API maps to the
single capability of submitting setpoint proposals — **not** the full operator role (operators also
assign profiles and register greenhouses, which the optimizer never does). This resolves RFC-009's open
question toward least privilege. The API validates the service token on the **same** JWKS /
issuer / audience / expiry path it already runs for human operator tokens
([P2 security §2](../specs/design/platform/07-spec-platform-security.md#2-the-authn--authz-split)) — one
token-validation mechanism, two actor types (`human` with viewer/operator roles; `service` with
`setpoints:write`).

The behavior is selected by a Phase 2 **`SERVICE_AUTH_MODE`** config value:

| `SERVICE_AUTH_MODE` | Phase 2 API behavior on `POST /setpoints` | Optimizer behavior | Deployment |
|---|---|---|---|
| `trusted_network` *(default)* | accepts the internal call without a service token | calls without a token | single-host local |
| `oidc` | requires a valid `setpoints:write` token; rejects unauthenticated | acquires a client-credentials token and presents it as `Bearer` | cloud / multi-host |

The setpoint **contract is unchanged** in both modes — same `POST /greenhouses/{id}/setpoints`, same
bodies, same `202`/`422`. Only the presence of an `Authorization` header and its enforcement differ. The
client secret is supplied via environment variable / Compose secret (`PLANNER_*`-style,
[optimizer config](../specs/design/optimizer/10-spec-optimizer-configuration.md)), never committed.
Provenance is unaffected mechanically but **strengthened**: in `oidc` mode `source = optimizer` is backed
by a verified client identity instead of being self-asserted.

**2. Platform → controller REST — per-controller pre-shared bearer token, presence-gated.**

Each controller gains an **optional** pre-shared bearer token in its TOML
([P1 config](../specs/design/controller/07-spec-controller-config-and-parameters.md)). The controller
requires it on the REST **write** endpoints (setpoint/threshold/override writes) and rejects
unauthenticated writes **iff the token is set**; **unset = check disabled = today's zero-friction
standalone binary** ([P1 deployment](../specs/design/controller/02-spec-controller-architecture.md#8-deployment)).
The platform stores the matching token in the **registry's controller-endpoint record**
([P2 fleet management](../specs/design/platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control))
and presents it on every downward REST call. This deliberately **does not** put OIDC in the minimal Rust
controller — a single trusted caller (the platform) does not warrant a full relying-party
implementation; a pre-shared token is the right weight. **Read** (status/health) endpoints stay open —
the platform polls them frequently and they carry no authority. Token rotation is static-at-provisioning
by default; the [deployment generation script](../specs/design/platform/08-spec-platform-operations.md#2-deployment)
is the natural place to mint one per controller if rotation is ever wanted.

**3. Optimizer → Phase 2 DB & 4. MQTT — unchanged.** The read-only `optimizer_ro` role
([RFC-008](#rfc-008-phase-3-telemetry-read-path)) is a least-privilege database credential, not service
authn, and is untouched. MQTT stays **anonymous** on the local network
([RFC-001](#rfc-001-mqtt-broker-selection)); it is telemetry-only
([RFC-007](#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)), carries
no command authority, and is therefore not a write boundary this RFC governs.

**Trust-boundary summary (committed):**

| Boundary | Direction | Mechanism | Default state |
|---|---|---|---|
| Human → platform API/SPA | read + write | Keycloak OIDC (Authorization Code + PKCE) — **unchanged** | on (2b) |
| Optimizer → Phase 2 API | write (setpoints) | Keycloak client-credentials → `setpoints:write`, gated by `SERVICE_AUTH_MODE` | **off** (`trusted_network`) |
| Platform → controller REST | write (setpoints/override) | Per-controller pre-shared bearer token (registry ↔ TOML) | **off** (token unset) |
| Optimizer → Phase 2 DB | read (history) | Read-only `optimizer_ro` role — unchanged | on |
| Any → MQTT broker | telemetry only | Anonymous on local network — unchanged | n/a |

### Alternatives Considered

- **Leave RFC-009 standing (do nothing now).** Rejected by operator direction: the seam stays prose in
  an RFC resolution, and a future cloud move re-derives the design under time pressure. Specifying the
  dormant mode now is near-zero cost and makes the upgrade a config flip.
- **Implement service auth always-on now (full RFC-009 Proposal, no gate).** Rejected: it loads the
  single-host MVP with Keycloak client registration, token acquisition/refresh in the optimizer, and
  per-controller token provisioning — exactly the operational surface RFC-009 judged disproportionate
  for one laptop. The `SERVICE_AUTH_MODE` gate keeps that weight opt-in.
- **A static API key / shared secret for the optimizer instead of Keycloak.** Rejected for the same
  reason RFC-009's Proposal rejected it: it stands up a *second* authn path beside the OIDC one the
  platform already runs. Client-credentials reuses Keycloak, so the API validates one kind of token.
- **OIDC in the controller too (symmetric with the optimizer).** Rejected: disproportionate for a
  minimal Rust process with one trusted caller; the pre-shared bearer token is the right weight.
- **mTLS across all internal services.** Still rejected as over-scoped for a local stack — a local CA
  and per-service cert rotation far exceed the threat model. Revisitable only if the deployment posture
  changes substantially beyond multi-host.

### Open Questions

- The exact Keycloak realm-role name (`setpoints:write` vs `optimizer:setpoints.write`) and client
  scope mapping — finalized when the Keycloak realm is configured in 2b; the spec commits to a *narrow
  service role*, not the wire name.
- Whether `oidc` mode should also require service auth on **read**-only platform surfaces consumed by
  future services — out of scope here; this RFC governs the two write boundaries.

### Resolution

**Accepted 2026-06-21.** Both internal write boundaries gain authentication, specified now and
**dormant by default**: the optimizer → Phase 2 API path via a `SERVICE_AUTH_MODE`-gated Keycloak
client-credentials token with a narrow `setpoints:write` role, and the platform → controller REST path
via a presence-gated per-controller bearer token. This **supersedes RFC-009**, whose human-only
Resolution is reversed; RFC-009 is retained as the deliberation record. No committed interface changes —
the setpoint contracts and the controller REST surface are identical in both modes, differing only in
whether an `Authorization` header is required. Implementation lands with the phases the seams live in
(Phase 2b for the Keycloak service client + `SERVICE_AUTH_MODE`; the controller token check + registry
field when managed-mode hardening is exercised); the contract documents
([`controller-rest`](../../contracts/controller-rest/), [`frontend-rest`](../../contracts/frontend-rest/))
gain the optional security scheme when those slices are built. See ADR entry 2026-06-21.
