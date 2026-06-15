# Phase 3 — Greenhouse Climate Optimizer (Spec)

Architectural specification for the Phase 3 optimizer: the **intelligence layer** that sits above
each greenhouse's deterministic Phase 1 controller and refines the climate targets Phase 2 resolves
from crop profiles. This describes the **software service**. For the physical system whose dynamics
it simulates — the sensors, actuators, and the coupling between climate variables — see
[`physical-system-single.md`](./physical-system-single.md); for the controller it ultimately steers,
see [`spec-controller-overview.md`](./controller/spec-controller-overview.md); for the platform it integrates
with, see [`spec-climate-platform.md`](./spec-climate-platform.md).

> Scope note: this is an architectural spec (components, responsibilities, behavior, configuration).
> Concrete code/module/class design is deferred until implementation. Wire formats (MQTT topics,
> payload schemas, REST shapes) are **referenced**, not redefined here — they live in
> [`contracts/`](../../../contracts/), the single source of truth all three phases conform to. The
> conventions those contracts follow (topic taxonomy, `greenhouse_id` / `zone_id` identity, payload
> envelope, JSON Schema format + versioning) are fixed by
> [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
> The full set of system contracts — every cross-component boundary — is catalogued in
> [`spec-contracts.md`](./spec-contracts.md).

---

## 1. Overview

Phase 3 is a **local Python service** that optimizes one greenhouse's climate by *thinking ahead*.
The Phase 1 controller is **reactive and crop-agnostic** — it regulates to whatever setpoints it is
given. Phase 2 supplies those setpoints as a **static** crop→targets baseline ("lettuce, fruiting →
these VPD / DLI / CO₂ / temperature targets"). Neither layer anticipates: the controller corrects
error after it appears, and the baseline does not move with the time of day or a cost signal.

Phase 3 closes that gap. It pulls a greenhouse's history, **simulates its climate forward**, uses an
LLM to propose a refined plan, **validates that plan against crop-safe and physical constraints**,
and pushes the refined targets down — pre-positioning for the known diurnal cycle, coordinating
coupled actuators, and trimming energy cost, all **within the crop-safe bounds Phase 2's profile
defines**. It optimizes setpoint *management*; it does not introduce the crop→targets mapping (that
is Phase 2's) and it does not command actuators directly (that is Phase 1's).

The optimizer is the intelligence layer above **each** greenhouse's controller. It operates on **one
greenhouse at a time** — N independent planning problems, mirroring the N independent control loops
of Phase 1. Site-wide orchestration across greenhouses, weather-reactive control, and combustion-heater
coordination are out of scope (see [§10](#10-scope--deferred--out-of-scope)).

---

## 2. Architecture

The optimizer runs a planning cycle per greenhouse: read history → simulate forward → plan → validate
→ apply. It **reads** telemetry directly from Phase 2's time-series store and **writes** refined
setpoints back through the Phase 2 REST API, which remains the single authority on intended state.

```
Phase 2 TimescaleDB
      │  historical telemetry (read-only)
      ▼
Data Access                          ← loads recent readings, actuator states, current setpoints
      │  observed state + baseline
      ▼
Digital Twin / Simulation            ← rolls climate forward over the planning horizon
      │  predicted trajectory
      ▼
LLM Planner                          ← proposes refined setpoints / actuator coordination
      │  candidate plan
      ▼
Constraint Engine                    ← validates against crop-safe bounds + physical limits
      │  within bounds          │  out of bounds / low confidence
      ▼                         ▼
Plan Applier              Operator Escalation
  │  refined setpoints           │  surfaced, not applied
  ▼                             ▼
Phase 2 REST API ──────────► (operator review)
      │  reconciles intended state
      ▼
Phase 1 Controller
```

| Component | Responsibility |
|---|---|
| Data Access | Read historical telemetry, actuator states, and current setpoints for one greenhouse from Phase 2's store; never writes |
| Digital Twin / Simulation | Roll heat / humidity / CO₂ / VPD / DLI forward over the planning horizon under candidate setpoints |
| LLM Planner | Propose refined setpoints and coupled-actuator coordination from the simulated trajectory and objectives |
| Constraint Engine | Validate every candidate plan against crop-safe bounds and physical limits before it can be applied |
| Plan Applier | Write within-bounds plans down via the Phase 2 REST API; route the rest to operator escalation |
| Service / API | FastAPI surface for triggering cycles, inspecting plans, and exposing escalations; service config & health |

The optimizer is a **client** of Phase 2, not a peer of Phase 1: it reads from Phase 2's history and
writes through Phase 2's setpoint API exactly as an operator edit would, layered on the crop-profile
baseline ([P2 §5](./spec-climate-platform.md#5-crop-profiles--setpoint-resolution)).

---

## 3. Digital Twin / Simulation Engine

The simulation engine is a **forward model** of a single greenhouse's climate, built on NumPy/SciPy.
Given an observed state and a candidate setpoint trajectory, it predicts how temperature, humidity,
CO₂, **VPD**, and accumulated **DLI** evolve over a planning horizon — the physics the Phase 1
controller deliberately approximates with first-order lag and the platform does not model at all
([P1 §12](./controller/spec-controller-constraints.md#9-scope--deferred-controller-capabilities)).

It models the **coupling** between climate variables and the **lag** between an actuator change and
its effect (see the coupling problem in
[`physical-system-single.md`](./physical-system-single.md)), so that a plan can be evaluated *before*
it is committed rather than discovered through controller error.

Crucially, the twin anticipates only **deterministic, clock-known** disturbances — the diurnal
solar/temperature curve and the day/night setpoint schedule. It pre-positions for *when the sun
predictably rises*, not for a variable forecast. Reacting to a real weather feed (a cold front, a
passing cloud) is **weather-reactive** control and belongs to Phase 4.

---

## 4. LLM-Driven Planning

The planner is implemented as a LangChain `Runnable` chain —
`ChatPromptTemplate | LLM | StructuredOutputParser` — with `ChatAnthropic` / `ChatOpenAI` as the
primary LLM wrappers and `ChatOllama` as the fallback, wired via `.with_fallbacks()`. Structured
plan output is parsed via `.with_structured_output(ActuatorPlan)`. See
[RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
(revised ADR entry 2026-06-11).

The planner is prompted with the observed state, the simulated forward trajectory, the active
crop-safe bounds, and the optimization objectives ([§7](#7-optimization-objectives)), and asked to
propose a **refined plan**: adjusted setpoints and a coordinated actuator strategy for the horizon.

The planner emits a **structured plan** (not prose) conforming to the schema in
[`contracts/`](../../../contracts/), so the constraint engine and applier can consume it
deterministically. The LLM **proposes**; it has no authority — every plan it emits is gated by the
constraint engine ([§5](#5-constraint-engine--safety)) before anything is applied. The plan also
carries a **confidence** signal used by the application gate ([§6](#6-setpoint-refinement--application)).

### Invocation strategy

Context preparation and call gating are applied in Python before `.invoke()` is called,
making the strategy backend-agnostic. The same rules apply whether the active backend is hosted or
local:

| Lever | Rule |
|---|---|
| **Fixed token budget** | `PlanContext` is serialized to a fixed token budget (default 4 000 tokens). If the budget is exceeded the serializer raises an explicit error — no silent truncation. |
| **Hourly telemetry summaries** | History is serialized as `(min, mean, max)` per sensor per hour, not raw readings. |
| **Adaptive horizon** | Default 12-hour horizon; extended to 24 h only when the cycle window crosses a day boundary (within 4 h of sunrise/sunset). |
| **State-change gate** | The LLM is not invoked if the current simulated trajectory deviates from the last accepted plan's trajectory by less than a configurable threshold. The current plan is extended instead. |
| **Fixed cycle cadence** | Planning cycles run on a fixed interval (default 30 minutes). The state-change gate controls actual LLM call frequency within that cadence. |

All five levers are configurable ([§9](#9-configuration)).

---

## 5. Constraint Engine & Safety

Every candidate plan passes through a deterministic **constraint engine** before it can be applied.
The engine validates the plan against:

- **Crop-safe bounds** — the min/max envelope the active crop profile defines for each target; the
  optimizer may move targets *within* this envelope but never outside it.
- **Physical limits** — actuator ranges, rate limits, and physically achievable setpoint combinations.

A plan that clears the engine is eligible for **auto-apply** ([§6](#6-setpoint-refinement--application));
a plan that violates any bound is **never applied** — it is rejected and escalated.

Safety is **layered and the controller is final**. The optimizer's constraint engine is an *advisory*
pre-filter on intended targets; it does **not** replace or override the Phase 1 controller's safety
interlocks, which remain controller-owned, run unconditionally on the live system, and are never
reachable by Phase 3 ([P1 spec](./controller/spec-controller-architecture.md#2-the-tick-pipeline)). Because the optimizer
writes only setpoints — never actuator commands — the controller's interlocks and actuator
constraints still bound everything that actually happens in the greenhouse.

---

## 6. Setpoint Refinement & Application

What Phase 3 adjusts are **targets**: the VPD / DLI / CO₂ / temperature setpoints that Phase 2 already
resolves from the crop profile. It refines them dynamically — shifting within the crop-safe envelope
to anticipate the diurnal cycle, coordinate actuators, and reduce cost — and writes the result down.
It **writes targets only**; it never commands actuators and never edits the crop profile itself.

**Delivery is through Phase 2.** The optimizer applies a refined setpoint bundle via the **Phase 2
REST API**, layered on the crop-profile baseline exactly as a sticky operator setpoint edit is
([P2 §5 — Resolution and the write path](./spec-climate-platform.md#5-crop-profiles--setpoint-resolution)).
Phase 2 is the **single authority for controller setpoints**
([RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
it enforces crop-safe bounds, records provenance (source `optimizer`, with an `optimizer_run_id` for
tracing), and is the sole delivery path to the controller — applying on change, re-asserting on
reconnect, and detecting drift. The optimizer submits refined targets via
`POST /greenhouses/{id}/setpoints` and either receives `202` (accepted) or `422` (rejected with the
violated bound); it does **not** write to controllers directly and does **not** publish actuator
commands.

**Application gate — auto-apply within bounds:**

| Plan outcome | Action |
|---|---|
| Passes constraint engine **and** meets the confidence threshold | **Auto-applied** via the Phase 2 REST API |
| Fails the constraint engine (out of crop-safe / physical bounds) | **Not applied** — escalated to an operator |
| Below the confidence threshold | **Not applied** — escalated to an operator |

Escalations are **surfaced, not executed**: the optimizer exposes the proposed plan and the reason it
was held for an operator to review, rather than applying a plan it cannot vouch for. The
within-bounds / confidence thresholds are configuration ([§9](#9-configuration)).

---

## 7. Optimization Objectives

Within the crop-safe envelope, the optimizer plans against three objectives:

| Objective | What it does |
|---|---|
| **Predictive / anticipatory control** | Simulate the greenhouse forward and pre-position setpoints for upcoming *clock-known* conditions instead of reacting after the fact — e.g. pre-cool ahead of the solar peak, ease into the night setpoint before the schedule flips. Deterministic disturbances only; no weather feed |
| **Coupling-aware planning** | Choose the optimal *combination* of coupled actuators (vent / fan / mister / heater) to hit VPD + DLI + CO₂ together, rather than independent reactive loops that fight each other |
| **Per-greenhouse efficiency** | Optimize one greenhouse's own consumption against a cost / time-of-use signal — shifting flexible load (e.g. lighting toward cheaper hours) while still meeting the crop's DLI and climate targets |

These objectives are weighted by configuration ([§9](#9-configuration)) and are always subordinate to
the crop-safe bounds enforced in [§5](#5-constraint-engine--safety).

---

## 8. Interfaces & Integration

| Interface | Direction | Role |
|---|---|---|
| **TimescaleDB** | Phase 2 store → optimizer | Read-only historical telemetry, actuator states, and current setpoints for one greenhouse. Per [RFC-008](../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path): connects as the dedicated `optimizer_ro` role with `SELECT`-only grants on a small set of named telemetry **views** (not the raw hypertables), which are a versioned read-surface contract. |
| **Phase 2 REST API** | Optimizer → platform | Write refined setpoint bundles (layered on the crop baseline); platform reconciles to the controller |
| **Service API (FastAPI)** | Operator/tools → optimizer | Trigger planning cycles, inspect proposed plans, review and act on escalations |

The optimizer **consumes** the contracts owned by [`contracts/`](../../../contracts/) and the Phase 2
interfaces ([P2 §5](./spec-climate-platform.md#5-crop-profiles--setpoint-resolution),
[P2 §13](./spec-climate-platform.md#13-interfaces--integration-with-phase-1)) rather than defining new
ones. It does **not** open its own channel to the Phase 1 controller — all downward influence flows
through Phase 2, preserving the platform's authority over intended state.

---

## 9. Configuration

The optimizer's service configuration — data-store DSN, Phase 2 API endpoint, LLM provider/endpoint,
objective weights, and the application-gate thresholds — is supplied via **environment variables /
the Compose file**, mirroring the Phase 2 convention rather than a per-greenhouse TOML (contrast the
controller's config). Per-greenhouse inputs (which house to plan, its crop-safe bounds) are read from
Phase 2 at cycle time, not configured here.

```toml
[data]
postgres_dsn = "postgresql://optimizer_ro:***@platform-db:5432/greenhouse"  # read-only role; SELECT on the RFC-008 view surface only
platform_api_url = "https://platform/api"

[llm]
# Primary backend: "anthropic" | "openai"
# Falls back to "ollama" automatically if the primary is unreachable.
provider = "anthropic"
model = "claude-sonnet-4-6"
api_key = ""                          # set via PLANNER_API_KEY env var; never in file
fallback_provider = "ollama"
fallback_model = "llama3"
fallback_endpoint = "http://ollama:11434"

[planning]
cycle_interval_minutes = 30
horizon_hours = 12                    # extended to 24 only near day boundaries
context_token_budget = 4000           # serializer raises if exceeded; no silent truncation
state_change_threshold = 0.05         # fraction deviation to suppress a cycle's LLM call
objective_weights = { anticipation = 1.0, coupling = 1.0, efficiency = 0.5 }

[application]
confidence_threshold = 0.8            # below → escalate to operator
# crop-safe bounds come from the Phase 2 crop profile, not from here
```

---

## 10. Scope — Deferred / Out of Scope

Optimizer capabilities intentionally **not** in Phase 3:

| Deferred / excluded | Why / where it belongs |
|---|---|
| Weather / forecast-reactive control | Reacting to a live + forecast outdoor feed (cold fronts, clouds) needs a weather source and stochastic planning — **Phase 4** ([spec-phase4.md](./spec-phase4.md)). Phase 3 anticipates only clock-known disturbances ([§3](#3-digital-twin--simulation-engine)) |
| Combustion-heater coordination | A single actuator coupling temperature + CO₂ + humidity breaks the independence the control loops assume and needs dedicated multi-variable coordination — **Phase 4** ([P1 §12](./controller/spec-controller-constraints.md#9-scope--deferred-controller-capabilities)) |
| Site-wide orchestration | Coordinated behavior across greenhouses (staggering loads, sharing constrained resources) needs a shared-infrastructure model that is out of scope; Phase 3 plans **one greenhouse at a time** ([§1](#1-overview)) |
| Introducing the crop → targets mapping | The static "this crop, this stage → these targets" mapping is **owned by Phase 2** ([P2 §5](./spec-climate-platform.md#5-crop-profiles--setpoint-resolution)); Phase 3 only **refines** within its crop-safe bounds |
| Direct actuator commanding | Driving individual actuators is **controller-owned** ([P1 spec](./controller/spec-controller-architecture.md#2-the-tick-pipeline)); Phase 3's downward influence is **setpoint-only**, through Phase 2 |
| Safety authority | Safety interlocks remain **controller-owned** and unconditional; the optimizer's constraint engine is an advisory pre-filter and never overrides them ([§5](#5-constraint-engine--safety)) |
| Writing directly to controllers | Phase 2 is the single authority on intended state; the optimizer writes refined setpoints **through the Phase 2 API**, never straight to a controller ([§6](#6-setpoint-refinement--application)) |
