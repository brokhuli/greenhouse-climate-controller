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
`ChatPromptTemplate | LLM | StructuredOutputParser`. The active chat-model wrapper is chosen by
configuration: `ChatOllama` is the **default** local backend (offline, key-free), with
`ChatAnthropic` / `ChatOpenAI` available as opt-in cloud backends. An optional secondary backend is
wired via `.with_fallbacks()`. Structured
plan output is parsed via `.with_structured_output(ActuatorPlan)`. See
[RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
(revised ADR entries 2026-06-11 and 2026-07-09).

The planner is prompted with the observed state, the simulated forward trajectory, the active
crop-safe bounds, and the [optimization objectives](#2-optimization-objectives), and asked to
propose a **refined setpoint trajectory** for the horizon. The plan may reason about actuator
coupling while choosing targets, but it does not contain actuator commands or a controller-side
actuator strategy.

The trajectory is a **planning artifact** spanning the horizon; Phase 3 does **not** write the whole
trajectory to Phase 2. Each cadence the optimizer applies only the **immediate next setpoint bundle** —
a single `SetpointsPatch` through the
[Phase 2 write path](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application) —
while the rest of the horizon informs the next cycle's
[state-change gate](#invocation-strategy) (which compares the current simulated trajectory against the
last accepted plan's). A scheduled or multi-step plan contract that hands Phase 2 a future trajectory is
deliberately out of Phase 3 scope ([scope](./12-spec-optimizer-scope.md)); the single-authority write
path stays a current-target merge.

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

> **These levers assume real-time (1×) operation.** The fixed cycle cadence and the
> adaptive horizon are **wall-clock-paced**, and the state-change gate compares trajectories over
> wall-clock-anchored windows — all of which presume the controller's clock tracks wall-clock. When a
> greenhouse runs under the P1 simulation
> [time-scale knob](../controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
> at `time_scale ≠ 1.0`, telemetry arrives faster/slower than wall-clock and these levers would
> desync from the plant — so the [input gate](./06-spec-optimizer-input-gating.md) holds
> the cycle *before* the planner is invoked rather than this layer compensating. The optimizer is
> explicitly not required to operate off 1× ([scope](./12-spec-optimizer-scope.md)); it resumes when
> the controller returns to real-time.

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

The active model is **pinned** in configuration (default `llama3` on the local Ollama backend; a cloud
model such as `claude-sonnet-4-6` when a cloud provider is configured,
[configuration](./10-spec-optimizer-configuration.md)). A model change — including switching provider —
is a deliberate, reviewed event recorded as an ADR entry — never a silent upgrade —
because it shifts the plan distribution and invalidates the evaluation baselines
([evaluation](./07-spec-optimizer-evaluation.md)). Any configured fallback backend is a **different
model** and will produce different plans for the same input; failover is therefore logged and traced
(`optimizer_run_id`, [P3-OBS-1](../../artifacts/non-functional-requirements.md)) and held to its own
baseline, not the primary backend's.

---

## 2. Optimization objectives

Within the crop-safe envelope, the optimizer plans against three objectives:

| Objective | What it does |
|---|---|
| **Predictive / anticipatory control** | Simulate the greenhouse forward and pre-position setpoints for upcoming *clock-known* conditions instead of reacting after the fact — e.g. pre-cool ahead of the solar peak, ease into the night setpoint before the schedule flips. Deterministic disturbances only; no weather feed |
| **Coupling-aware planning** | Choose setpoint trajectories that account for how coupled actuators will respond (vent / fan / mister / heater), so VPD + DLI + CO₂ are optimized together without issuing actuator commands |
| **Per-greenhouse efficiency** | Optimize one greenhouse's own consumption against the local cost / time-of-use schedule in configuration, shifting flexible load (e.g. lighting toward cheaper hours) while still meeting the crop's DLI and climate targets |

These objectives are weighted by configuration ([configuration](./10-spec-optimizer-configuration.md))
and are always subordinate to the crop-safe bounds enforced by the
[constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety).
The Phase 3 cost signal is deliberately local and static: a configured time-of-use schedule, not an
external tariff feed. Live price feeds or site-wide load coordination are deferred with the other
shared-input concerns in [scope](./12-spec-optimizer-scope.md).
