# Optimizer — Evaluation & Regression Testing

> **Purpose:** Define the strategy that exercises the planner and holds its plan
> quality stable as the prompt, model, or backend changes — the constraint-engine
> regression suite, the golden-scenario library run through the deterministic twin,
> and the per-backend plan-variance baselines.

Part of the [optimizer set](./01-spec-optimizer-overview.md); this builds on the
deterministic gates in
[constraints & application](./06-spec-optimizer-constraints-and-application.md) and the
deterministic forward model in
[digital twin](./03-spec-optimizer-digital-twin.md).

---

The constraint engine gives the planner an objective, deterministic correctness gate — but the planner
*itself* needs to be exercised, and its plan quality held stable as the prompt, model, or backend
changes. [P3-TEST-1](../../artifacts/non-functional-requirements.md) already requires that 100% of plans
pass the constraint engine before apply (with ≥ 90% bound-check coverage); this section defines the
strategy around it. (Concrete test framework and fixtures are deferred to implementation, per the
scope note in [the overview](./01-spec-optimizer-overview.md).)

1. **Constraint-engine regression suite.** The deterministic gate is unit-tested against a corpus of
   known-good and known-bad plans — out-of-bounds targets, infeasible coupled-actuator combinations,
   and sub-threshold confidence — asserting each is accepted, rejected, or escalated as specified
   ([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety),
   [application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)).
   This is where the ≥ 90% bound-check coverage of P3-TEST-1 is met.

2. **Golden-scenario library, run through the digital twin.** The twin
   ([forward model](./03-spec-optimizer-digital-twin.md#1-the-forward-model))
   is a deterministic forward model, making it the optimizer-side analog of the controller's seeded HAL
   ([P1-TEST-2](../../artifacts/non-functional-requirements.md): deterministic under a fixed seed).
   Scenarios deliberately reach past the happy path: diurnal ramp, steady state, a transient
   disturbance, **sensor dropout / stale input** (which must trip the
   [input gate](./07-spec-optimizer-input-gating.md), not produce a plan), a **twin divergence /
   parameter-drift** case (which must trip the
   [twin-robustness path](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity) — extend and
   escalate, or attenuate confidence — not yield a confident plan over a bad trajectory), contradictory
   objectives, and the near-day-boundary horizon extension.
   Each scenario fixes observed state, history, and bounds, then asserts the resulting plan stays within
   crop-safe range and bundle consistency and moves the objectives
   ([objectives](./04-spec-optimizer-planning.md#2-optimization-objectives)) in the intended direction.

3. **Plan-variance baselines.** Because the LLM is stochastic even at temperature 0
   ([determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)), regression is
   **bounded comparison, not exact match**: a re-run of a scenario must land within a tolerance band of
   the recorded baseline plan. Baselines are re-captured **deliberately** when the model, prompt, or
   sampling config changes — the same trigger as a model-pin change in
   [planning](./04-spec-optimizer-planning.md#1-llm-driven-planning) — and are kept **per backend**,
   since each configured backend (the default local Ollama model, an opt-in cloud model, or any
   fallback) produces a different distribution and must each be held to its own baseline.

An end-to-end integration test exercises the full path — read → twin → planner → constraint engine →
applier — against the deterministic twin, asserting the application gate
([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application))
routes auto-apply versus escalation correctly.
