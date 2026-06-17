# Optimizer — LLM Planning & Objectives

> **Purpose:** Define the LLM planner — the LangChain chain, the backend-agnostic
> invocation strategy, and the determinism discipline that makes plans
> regression-testable — and the three **optimization objectives** it plans against
> within the crop-safe envelope.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the planner consumes the
trajectory from the [digital twin](./03-spec-optimizer-digital-twin.md) and every plan
it emits is gated downstream by the
[constraint engine](./05-spec-optimizer-constraints-and-application.md).

---

## 1. LLM-driven planning

The planner is implemented as a LangChain `Runnable` chain —
`ChatPromptTemplate | LLM | StructuredOutputParser` — with `ChatAnthropic` / `ChatOpenAI` as the
primary LLM wrappers and `ChatOllama` as the fallback, wired via `.with_fallbacks()`. Structured
plan output is parsed via `.with_structured_output(ActuatorPlan)`. See
[RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
(revised ADR entry 2026-06-11).

The planner is prompted with the observed state, the simulated forward trajectory, the active
crop-safe bounds, and the [optimization objectives](#2-optimization-objectives), and asked to
propose a **refined plan**: adjusted setpoints and a coordinated actuator strategy for the horizon.

The planner emits a **structured plan** (not prose) conforming to the schema in
[`contracts/`](../../../../contracts/), so the constraint engine and applier can consume it
deterministically. The LLM **proposes**; it has no authority — every plan it emits is gated by the
constraint engine
([constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
before anything is applied. The plan also carries a **confidence** signal used by the
[application gate](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application).

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

All five levers are configurable ([configuration](./10-spec-optimizer-configuration.md)).

### Determinism & reproducibility

The planner's sampling is **pinned** so plans are reproducible enough to test, diff, and debug. The
temperature is fixed at **0** (greedy decoding), `top_p` at `1.0`, and the response is capped at a
fixed token budget — all set in configuration ([configuration](./10-spec-optimizer-configuration.md))
and applied identically to whichever backend is active, keeping the strategy backend-agnostic
([P3-MOD-1](../../artifacts/non-functional-requirements.md)).

Determinism here is **bounded, not absolute**. Even at temperature 0, model serving introduces minor
run-to-run variance, and a low temperature is *not* what makes a plan safe — the deterministic
constraint engine
([constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
and the
[confidence gate](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
are. Sampling is pinned to make plans *reproducible enough to regression-test*
([evaluation](./07-spec-optimizer-evaluation.md)), not to guarantee identical output.

The model is **pinned** (`claude-sonnet-4-6`, [configuration](./10-spec-optimizer-configuration.md)). A
model change is a deliberate, reviewed event recorded as an ADR entry — never a silent upgrade —
because it shifts the plan distribution and invalidates the evaluation baselines
([evaluation](./07-spec-optimizer-evaluation.md)). The Ollama fallback (`llama3`) is a **different
model** and will produce different plans for the same input; failover is therefore logged and traced
(`optimizer_run_id`, [P3-OBS-1](../../artifacts/non-functional-requirements.md)) and held to its own
baseline, not the primary backend's.

---

## 2. Optimization objectives

Within the crop-safe envelope, the optimizer plans against three objectives:

| Objective | What it does |
|---|---|
| **Predictive / anticipatory control** | Simulate the greenhouse forward and pre-position setpoints for upcoming *clock-known* conditions instead of reacting after the fact — e.g. pre-cool ahead of the solar peak, ease into the night setpoint before the schedule flips. Deterministic disturbances only; no weather feed |
| **Coupling-aware planning** | Choose the optimal *combination* of coupled actuators (vent / fan / mister / heater) to hit VPD + DLI + CO₂ together, rather than independent reactive loops that fight each other |
| **Per-greenhouse efficiency** | Optimize one greenhouse's own consumption against a cost / time-of-use signal — shifting flexible load (e.g. lighting toward cheaper hours) while still meeting the crop's DLI and climate targets |

These objectives are weighted by configuration ([configuration](./10-spec-optimizer-configuration.md))
and are always subordinate to the crop-safe bounds enforced by the
[constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety).
