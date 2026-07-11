# Optimizer — Digital Twin & Simulation

> **Purpose:** Define the optimizer's **forward model** of a single greenhouse's
> climate — what it predicts and the deterministic disturbances it anticipates — and
> the guards on the model's own **numerical behavior** and **parameter fidelity** that
> keep a diverged or de-calibrated twin from feeding the planner a confident-but-wrong
> future.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the trajectory this
model produces is what the [planner](./04-spec-optimizer-planning.md) optimizes
against.

---

## 1. The forward model

The simulation engine is a **forward model** of a single greenhouse's climate, built on NumPy/SciPy.
Given an observed state and a given setpoint trajectory, it predicts how temperature, humidity,
CO₂, **VPD**, and accumulated **DLI** evolve over a planning horizon — the physics the Phase 1
controller deliberately approximates with first-order lag and the platform does not model at all
([P1 constraints §9](../controller/10-spec-controller-constraints.md#9-scope--deferred-controller-capabilities)).

It models the **coupling** between climate variables and the **lag** between an actuator change and
its effect (see the coupling problem in
[`physical-system-single.md`](../physical-system-single.md)), so that a plan can be evaluated *before*
it is committed rather than discovered through controller error.

Crucially, the twin anticipates only **deterministic, clock-known** disturbances — the diurnal
solar/temperature curve and the day/night setpoint schedule. It pre-positions for *when the sun
predictably rises*, not for a variable forecast. Reacting to a real weather feed (a cold front, a
passing cloud) is **weather-reactive** control and belongs to Phase 4.

> **Implementation-readiness — Digital Twin v1 (TBD).** This section fixes *what* the twin predicts and
> the disturbances it anticipates; the **quantitative model is still owed to implementation** and is the
> single largest open item in this set. Before the twin can be built, v1 must pin down:
>
> - **Governing equations** — the coupled ODEs for temperature, humidity, and CO₂ (with VPD and DLI derived), including the actuator-lag terms.
> - **Per-greenhouse parameters** — thermal mass, leakage / infiltration, actuator gains and lag constants — and their **source**: seeded from the [physical-system model](../physical-system-single.md) / config to start, since auto-fitting is out of scope ([§2](#parameter-fidelity--drift)).
> - **Controller approximation** — how the twin represents the Phase 1 controller's closed-loop response while rolling the baseline forward (the controller is *in the loop* being simulated).
> - **One-step residual formula** — the exact predicted-vs-observed error the drift check in [§2](#parameter-fidelity--drift) thresholds against `twin.divergence_threshold`.
> - **Deterministic-disturbance model** — the diurnal solar / temperature curve and the day/night schedule the twin pre-positions for ([§1](#1-the-forward-model)).
>
> These are recorded here as a checklist, not solved; the equations and parameter set land with the twin
> implementation (or a dedicated twin-definition spec).

---

## 2. Robustness & fidelity

[The forward model](#1-the-forward-model) above describes what the twin computes, and
[input gating](./07-spec-optimizer-input-gating.md) gates its **inputs** — but nothing yet guards the
twin's own **numerical behavior** or whether its **parameters still match the real greenhouse**. A
forward model can diverge (stiff dynamics, a bad step) or silently de-calibrate (thermal mass,
leakage, or a failing vent seal change over weeks) — and either failure yields a confident trajectory
the planner then optimizes against. The output gates
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety),
[application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application))
cannot catch it, because the resulting *plan* looks perfectly valid; the error is upstream, in the
future the plan was built on.

### Numerical stability

The integrator runs with a bounded step (`twin.solver_max_step_minutes`,
[configuration](./11-spec-optimizer-configuration.md)) and checks every step for **non-finite** state
(NaN / Inf), states outside **physically plausible** envelopes (temperature past sensor range,
negative humidity or CO₂), and **non-convergence** within a step budget. A diverged simulation is
treated exactly like a failed input precondition ([input gating](./07-spec-optimizer-input-gating.md)):
the optimizer does **not** hand a garbage trajectory to the planner — it extends the last accepted
plan and raises a `twin_diverged` escalation
([reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)), traced by `optimizer_run_id`
([P3-OBS-1](../../artifacts/non-functional-requirements.md)). The solver is fixed-step / seeded so a
scenario reproduces, making the twin the deterministic forward model
[evaluation](./08-spec-optimizer-evaluation.md) already relies on — the optimizer-side analog of the
controller's seeded HAL ([P1-TEST-2](../../artifacts/non-functional-requirements.md)).

### Parameter fidelity & drift

The twin is parameterized per greenhouse (thermal mass, leakage, actuator gains and lag) — physical
constants that drift seasonally and as equipment ages. Each cycle the optimizer computes a
**one-step-ahead residual**: the previous cycle's predicted trajectory against the now-observed
telemetry. A residual that stays beyond `twin.divergence_threshold`
([configuration](./11-spec-optimizer-configuration.md)) is a **fidelity fault** — the model no longer
matches the greenhouse. The response is **graded, not binary**: the twin keeps running (a degraded
prediction still beats none), but plan **confidence is attenuated** so a low-fidelity model's plans
fall below the
[application-gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
threshold and **escalate rather than auto-apply** (`twin_fidelity_fault`,
[reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)), and persistent divergence is
surfaced for recalibration. Refitting the parameters from history is **deferred**
([scope](./13-spec-optimizer-scope.md)) — Phase 3 *detects and flags* drift; it does not auto-tune.

The crop-safe constraint engine
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
and the controller's interlocks remain the hard backstop regardless of twin quality, so a drifted or
diverged twin **degrades optimization, never safety** — the same principle as everywhere else in this
spec: the deterministic gates, not the model, are what keep the greenhouse safe.
