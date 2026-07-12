# Optimizer — LLM Planning & Objectives

> **Purpose:** Define the LLM planner — the LangChain chain, the backend-agnostic
> invocation strategy, and the determinism discipline that makes plans
> regression-testable — and the three **optimization objectives** it plans against
> within the crop-safe envelope.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the planner consumes the
trajectory from the [digital twin](./03-spec-optimizer-digital-twin.md) and every plan
it emits is gated downstream by the
[constraint engine](./06-spec-optimizer-constraints-and-application.md).

---

## 1. LLM-driven planning

The planner is implemented as a LangChain `Runnable` chain —
`ChatPromptTemplate | LLM | StructuredOutputParser`. The active chat-model wrapper is chosen by
configuration: `ChatOllama` is the **default** local backend (offline, key-free), with
`ChatAnthropic` / `ChatOpenAI` available as opt-in cloud backends. An optional secondary backend is
wired via `.with_fallbacks()`. Structured
plan output is parsed via `.with_structured_output(OptimizerPlan)`. See
[RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
(revised ADR entries 2026-06-11 and 2026-07-09).

The planner is prompted with the observed state, the twin's simulated forward trajectory of the
**current baseline** ([architecture — cycle order](./02-spec-optimizer-architecture.md#cycle-order-simulate-then-plan)),
the active crop-safe bounds, and the [optimization objectives](#2-optimization-objectives), and asked to
propose a **refined setpoint trajectory** for the horizon. The plan may reason about actuator
coupling while choosing targets, but it does not contain actuator commands or a controller-side
actuator strategy. In Phase 3 v1 the planner's own candidate is **not** re-simulated through the twin;
its proposed targets are validated against bounds downstream ([scope](./13-spec-optimizer-scope.md)).

The trajectory is a **planning artifact** spanning the horizon; Phase 3 does **not** write the whole
trajectory to Phase 2. Each cadence the optimizer applies only the **immediate next setpoint bundle** —
a single `SetpointsPatch` through the
[Phase 2 write path](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application) —
while the rest of the horizon is held in memory so a skipped cycle can **extend the plan** by carrying
the next hour's setpoints forward ([state-change gate](#invocation-strategy)). That setpoint horizon is
**not** what the gate diffs — the gate compares the twin's **predicted-climate** forecast across cycles
(below), a climate series, not this setpoint series. A scheduled or multi-step plan contract that hands
Phase 2 a future trajectory is deliberately out of Phase 3 scope ([scope](./13-spec-optimizer-scope.md));
the single-authority write path stays a current-target merge.

The planner emits a **structured plan** (not prose) conforming to the schema in
[`contracts/`](../../../../contracts/), so the constraint engine and applier can consume it
deterministically. The LLM **proposes**; it has no authority — every plan it emits is gated by the
constraint engine
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
before anything is applied. The plan also carries a **confidence** signal used by the
[application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application).

### Invocation strategy

Context preparation and call gating are applied in Python before `.invoke()` is called,
making the strategy backend-agnostic. The same rules apply whether the active backend is hosted or
local:

| Lever | Rule |
|---|---|
| **Fixed token budget** | `PlanContext` is serialized to a fixed token budget (default 4 000 tokens). If the budget is exceeded the serializer raises an explicit error — no silent truncation. |
| **Hourly telemetry summaries** | History is serialized as `(min, mean, max)` per sensor per hour, not raw readings. |
| **Adaptive horizon** | Default 12-hour horizon; extended to 24 h only when the cycle window crosses a day boundary (within 4 h of sunrise/sunset). |
| **State-change gate** | The LLM is not invoked if the twin's **predicted-climate forecast** for this cycle deviates from the **reference forecast** — the forecast retained from the last cycle that ran the planner — by less than a configurable threshold, over their overlapping window. The current plan is **extended** instead: the retained setpoint trajectory is carried forward, or the Phase 2 baseline is held if no prior plan exists ([resilience](./09-spec-optimizer-resilience.md)). Both the reference forecast and the setpoint trajectory are **in-memory only**, so on the first cycle after a restart there is nothing to diff against — the gate is skipped and the LLM runs to rebuild the baseline ([resilience — stateless restart](./09-spec-optimizer-resilience.md)). The reference is a twin **climate** series, never `OptimizerPlan.trajectory` (setpoints); the two are kept distinct ([digital twin §1.6](./03-spec-optimizer-digital-twin.md#16-twin-output-predicted-trajectory)). |
| **Fixed cycle cadence** | Planning cycles run on a fixed interval (default 30 minutes). The state-change gate controls actual LLM call frequency within that cadence. |

All five levers are configurable ([configuration](./11-spec-optimizer-configuration.md)).

> **These levers assume real-time (1×) operation.** The fixed cycle cadence and the
> adaptive horizon are **wall-clock-paced**, and the state-change gate compares climate forecasts over
> wall-clock-anchored windows — all of which presume the controller's clock tracks wall-clock. When a
> greenhouse runs under the P1 simulation
> [time-scale knob](../controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
> at `time_scale ≠ 1.0`, telemetry arrives faster/slower than wall-clock and these levers would
> desync from the plant — so the [input gate](./07-spec-optimizer-input-gating.md) holds
> the cycle *before* the planner is invoked rather than this layer compensating. The optimizer is
> explicitly not required to operate off 1× ([scope](./13-spec-optimizer-scope.md)); it resumes when
> the controller returns to real-time.

### Determinism & reproducibility

The planner's sampling is **pinned** so plans are reproducible enough to test, diff, and debug. The
temperature is fixed at **0** (greedy decoding), `top_p` at `1.0`, and the response is capped at a
fixed token budget — all set in configuration ([configuration](./11-spec-optimizer-configuration.md))
and applied identically to whichever backend is active, keeping the strategy backend-agnostic
([P3-MOD-1](../../artifacts/non-functional-requirements.md)).

Determinism here is **bounded, not absolute**. Even at temperature 0, model serving introduces minor
run-to-run variance, and a low temperature is *not* what makes a plan safe — the deterministic
constraint engine
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
and the
[confidence gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
are. Sampling is pinned to make plans *reproducible enough to regression-test*
([evaluation](./08-spec-optimizer-evaluation.md)), not to guarantee identical output.

The active model is **pinned** in configuration (default `llama3` on the local Ollama backend; a cloud
model such as `claude-sonnet-4-6` when a cloud provider is configured,
[configuration](./11-spec-optimizer-configuration.md)). A model change — including switching provider —
is a deliberate, reviewed event recorded as an ADR entry — never a silent upgrade —
because it shifts the plan distribution and invalidates the evaluation baselines
([evaluation](./08-spec-optimizer-evaluation.md)). Any configured fallback backend is a **different
model** and will produce different plans for the same input; failover is therefore logged and traced
(`optimizer_run_id`, [P3-OBS-1](../../artifacts/non-functional-requirements.md)) and held to its own
baseline, not the primary backend's.

### Prompt template & versioning

The `ChatPromptTemplate`'s instruction text is **not** an inline Python string or an environment
variable — it is a **versioned text asset checked into the service**, at
`climate-optimizer/prompts/planner.v{N}.md`. This mirrors how the rest of the fleet stores a governed,
diffable asset in its service tree: the controller's `climate-controller/config/greenhouse.example.toml`
and the platform's numbered `climate-platform/internal/store/migrations/`. The file holds the planner's
**system-prompt template** — the static instruction and objective framing — which the chain wraps into
the `ChatPromptTemplate`; the per-cycle `PlanContext` is the **human turn**, assembled by the
serializer described under [invocation strategy](#invocation-strategy) (fixed token budget, hourly
summaries), not baked into the template file.

The active template is **pinned by a `prompt_version`** in configuration, alongside the model pin
([`[llm]` config](./11-spec-optimizer-configuration.md)); the chain resolves
`prompts/planner.v{prompt_version}.md` at construction. A released `planner.vN.md` is treated as
**immutable — like an applied SQL migration, it is never edited in place**: a prompt change ships a new
`planner.v{N+1}.md` and bumps the pin, so `prompt_version` always names the exact text that ran.

A prompt change is therefore a **deliberate, reviewed event recorded as an ADR entry — never a silent
edit** — the same governance as the model pin above, because it shifts the plan distribution and
invalidates the evaluation baselines, which are **re-captured per backend** on a prompt bump
([evaluation §3](./08-spec-optimizer-evaluation.md)). The pinned `prompt_version` is stamped into
`PlanRecord.backend` next to `model` and traced with `optimizer_run_id`
([plan contract §3](./05-spec-optimizer-plan-contract.md#3-planrecord--the-optimizer-service-envelope),
`P3-OBS-1`), so every stored or surfaced plan is traceable to the exact `(model, prompt_version,
sampling)` that produced it.

---

## 2. Optimization objectives

Within the crop-safe envelope, the optimizer plans against three objectives:

| Objective | What it does |
|---|---|
| **Predictive / anticipatory control** | Simulate the greenhouse forward and pre-position setpoints for upcoming *clock-known* conditions instead of reacting after the fact — e.g. pre-cool ahead of the solar peak, ease into the night setpoint before the schedule flips. Deterministic disturbances only; no weather feed |
| **Coupling-aware planning** | Choose setpoint trajectories that account for how coupled actuators will respond (vent / fan / mister / heater), so VPD + DLI + CO₂ are optimized together without issuing actuator commands |
| **Per-greenhouse efficiency** | Optimize one greenhouse's own consumption against the local cost / time-of-use schedule in configuration, shifting flexible load (e.g. lighting toward cheaper hours) while still meeting the crop's DLI and climate targets |

These objectives are weighted by configuration ([configuration](./11-spec-optimizer-configuration.md))
and are always subordinate to the crop-safe bounds enforced by the
[constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety).
The Phase 3 cost signal is deliberately local and static: a configured time-of-use schedule, not an
external tariff feed. Live price feeds or site-wide load coordination are deferred with the other
shared-input concerns in [scope](./13-spec-optimizer-scope.md).
