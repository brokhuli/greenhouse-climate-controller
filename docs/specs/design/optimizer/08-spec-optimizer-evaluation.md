# Optimizer — Evaluation & Regression Testing

> **Purpose:** Define the strategy that exercises the planner and holds its plan
> quality stable as the prompt, model, or backend changes — the constraint-engine
> regression suite, the golden-scenario library run through the deterministic twin,
> the per-backend plan-variance baselines, and the plan-contract schema checks.

Part of the [optimizer set](./01-spec-optimizer-overview.md); this builds on the
deterministic gates in
[constraints & application](./06-spec-optimizer-constraints-and-application.md), the
deterministic forward model in
[digital twin](./03-spec-optimizer-digital-twin.md), and the structured
[plan contract](./05-spec-optimizer-plan-contract.md) whose schema and fixtures live in
[`contracts/optimizer-plan/`](../../../../contracts/optimizer-plan/).

---

The constraint engine gives the planner an objective, deterministic correctness gate — but the planner
*itself* needs to be exercised, and its plan quality held stable as the prompt, model, or backend
changes. [P3-TEST-1](../../artifacts/non-functional-requirements.md) already requires that 100% of plans
pass the constraint engine before apply (with ≥ 90% bound-check coverage); this section defines the
strategy around it. (Concrete test framework and fixtures are deferred to implementation, per the
scope note in [the overview](./01-spec-optimizer-overview.md).)

1. **Constraint-engine & application-gate regression suite.** The deterministic gates are unit-tested
   against a corpus of known-good and known-bad plans. The **constraint engine** sees out-of-bounds
   targets and **self-inconsistent setpoint bundles** (`humidity_low_pct > humidity_high_pct`, a
   malformed day window, a negative duration) — the only two checks it makes, having no actuator model
   ([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety)) —
   each asserted rejected as `constraint_violation`. The **application gate** sees a sub-threshold
   `confidence` plan, asserted escalated as `low_confidence`
   ([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application),
   [reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)); known-good plans clear
   both. This is where the ≥ 90% bound-check coverage of P3-TEST-1 is met.

2. **Golden-scenario library, run through the digital twin.** The twin
   ([forward model](./03-spec-optimizer-digital-twin.md#1-the-forward-model))
   is a deterministic forward model, making it the optimizer-side analog of the controller's seeded HAL
   ([P1-TEST-2](../../artifacts/non-functional-requirements.md): deterministic under a fixed seed). Each
   scenario fixes observed state, history, and bounds. The **trajectory-shaping** scenarios assert the
   resulting plan stays within crop-safe range and bundle consistency and moves the objectives
   ([objectives](./04-spec-optimizer-planning.md#2-optimization-objectives)) in the intended direction;
   the **robustness** scenarios assert the correct gate trips and the plan is held. The library pins the
   **concrete v1 twin behaviors** ([governing equations](./03-spec-optimizer-digital-twin.md#12-governing-equations)),
   not a generic happy path:

   - **Steady state** — with setpoints held at equilibrium the twin sits at its fixed point and does
     not drift (the exponential update is exact there,
     [§1.2](./03-spec-optimizer-digital-twin.md#12-governing-equations)).
   - **Sunrise/sunset diurnal** — the raised half-sine solar over `[sunrise, sunset)`
     ([§1.4](./03-spec-optimizer-digital-twin.md#14-deterministic-disturbances)) drives PAR and
     temperature up then down, is zero at night, accumulates DLI and resets it at UTC-of-day midnight,
     and switches the day/night `T_set`; the plan pre-positions for the predictable ramp.
   - **Venting coupling** — a cooling call drives roof vents/fans, which the coupling matrix requires to
     co-drop temperature **and** CO₂ **and** RH together, and the CO₂ injector is forced off above
     `co2_vent_interlock_threshold_pct`
     ([§1.2](./03-spec-optimizer-digital-twin.md#12-governing-equations),
     [§1.3](./03-spec-optimizer-digital-twin.md#13-controller-approximation-reduced)).
   - **Misting coupling** — misters raise RH **and** drop temperature together (+40 %RH / −3 °C,
     [§1.2](./03-spec-optimizer-digital-twin.md#12-governing-equations)).
   - **Sensor dropout / stale input** — must trip the [input gate](./07-spec-optimizer-input-gating.md),
     not produce a plan.
   - **Numerical divergence** — a stiff or non-finite step must trip the twin's numerical-stability
     guard ([§2](./03-spec-optimizer-digital-twin.md#numerical-stability)): the optimizer extends the
     last accepted plan and escalates `twin_diverged`, never planning over a garbage trajectory.
   - **Residual / fidelity fault** — a seeded parameter drift whose one-step-ahead residual `R` stays
     over `divergence_threshold` for `fidelity_breach_cycles` consecutive cycles must raise
     `twin_fidelity_fault` ([§2](./03-spec-optimizer-digital-twin.md#parameter-fidelity--drift)): the
     twin keeps running but `confidence` is hard-capped below threshold so the plan escalates rather
     than auto-applies. A cold-start cycle with no prior trajectory, or a `to` past the retained
     trajectory's span, must **skip** the check, not fault.
   - **Contradictory objectives** and the **near-day-boundary horizon extension** round out the set.

   The venting and misting scenarios exist to verify the **coupling** objective
   ([objectives](./04-spec-optimizer-planning.md#2-optimization-objectives)) the twin is built to
   expose; the two robustness faults map one-to-one onto the `twin_diverged` and `twin_fidelity_fault`
   [reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes).

3. **Plan-variance baselines.** Because the LLM is stochastic even at temperature 0
   ([determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)), regression is
   **bounded comparison, not exact match**: a re-run of a scenario must land within a tolerance band of
   the recorded baseline plan. Baselines are re-captured **deliberately** when the model, prompt, or
   sampling config changes — the same trigger as a model-pin change in
   [planning](./04-spec-optimizer-planning.md#1-llm-driven-planning) — and are kept **per backend**,
   since each configured backend (the default local Ollama model, an opt-in cloud model, or any
   fallback) produces a different distribution and must each be held to its own baseline.

4. **Plan-contract schema checks.** The `OptimizerPlan` / `PlanRecord` JSON Schema
   ([plan contract](./05-spec-optimizer-plan-contract.md),
   [`contracts/optimizer-plan/`](../../../../contracts/optimizer-plan/); catalogued in
   [spec-contracts §2.6](../spec-contracts.md#26-optimizer-plan-schema)) is exercised by the shared
   **contract harness**, the way every other contract's fixtures are: the valid fixtures
   (`optimizer-plan.json`, `plan-record.applied.json`, `plan-record.escalated-low-confidence.json`)
   must validate, and the deliberately-invalid `optimizer-plan.bad-confidence.json` (`confidence`
   outside `[0, 1]`) must be **rejected**. This pins the `.with_structured_output(OptimizerPlan)`
   boundary ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)) — the exact shape
   the planner is asked to fill — independently of any model run.

An end-to-end integration test exercises the full path — read → twin → planner → constraint engine →
applier — against the deterministic twin, asserting the gates route the cycle to the correct
`PlanRecord.outcome.status`
([plan contract §3](./05-spec-optimizer-plan-contract.md#3-planrecord--the-optimizer-service-envelope)):
`applied` when a plan clears both gates, `escalated` (with `low_confidence` or the tripped twin reason
code) when a gate holds it, and `extended` when the state-change gate carries the prior plan forward
([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)).
