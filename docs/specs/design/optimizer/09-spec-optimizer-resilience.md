# Optimizer — Service Resilience & Recovery

> **Purpose:** Keep the long-running optimizer service recoverable and its
> operator-facing surfaces honest under failure — stateless restart, fail-fast config
> validation, escalation backpressure, and a health/cadence watchdog. Where the other
> guardrails keep individual *cycles* safe, this keeps the *service* safe.

Part of the [optimizer set](./01-spec-optimizer-overview.md); it builds on the
per-cycle guards in
[input gating](./07-spec-optimizer-input-gating.md),
[twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity), and
[write-path concurrency](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation).

---

The optimizer is a long-running FastAPI service ([architecture](./02-spec-optimizer-architecture.md),
[interfaces](./10-spec-optimizer-interfaces.md)).
[Input gating](./07-spec-optimizer-input-gating.md),
[twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity), and
[write-path concurrency](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation)
keep individual *cycles* safe; this section keeps the *service* recoverable and its operator-facing
surfaces honest under failure — mirroring the controller's restart treatment
([02-spec-controller-architecture.md §9](../controller/02-spec-controller-architecture.md#9-availability-restart--resource-footprint))
and the platform's operational resilience
([08-spec-platform-operations.md](../platform/08-spec-platform-operations.md)).

- **Stateless restart.** The optimizer holds no authoritative persistent state. Intended state lives
  in Phase 2. The optimizer's only across-cycle memory is the last accepted plan — its applied
  **setpoint bundle** (the baseline), the full **horizon setpoint trajectory** the degrade fallbacks
  carry forward to **extend** the plan ([input gating](./07-spec-optimizer-input-gating.md),
  [twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity)), *and* the **reference
  climate forecast** the state-change gate
  ([planning](./04-spec-optimizer-planning.md#invocation-strategy)) diffs against
  ([digital twin §1.6](./03-spec-optimizer-digital-twin.md#16-twin-output-predicted-trajectory)) — and
  these recover **asymmetrically** on restart. The applied bundle *is* reconstructable: it is the current
  setpoints Phase 2 already holds. The setpoint **trajectory** and the **reference forecast**, though, are
  **in-memory only** — per-cycle planning artifacts ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning))
  Phase 3 v1 persists nowhere, so they **cannot** be rebuilt from Phase 2. A restart therefore re-reads
  config, reconnects to the Phase 2 REST API
  ([RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path)), reads the
  current setpoints as its baseline, and resumes on the next cadence tick with **no prior trajectory and
  no reference forecast**: the [state-change gate](./04-spec-optimizer-planning.md#invocation-strategy) is
  **disabled for that first cycle** — it has nothing to diff against, so it plans fresh — and rebuilds
  from the baseline that first cycle produces. There is nothing to replay. While the optimizer
  is down, the Phase 2 baseline continues unchanged
  ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)) and the controller holds its last
  accepted setpoints ([P3-REL-1](../../artifacts/non-functional-requirements.md)) — a restart costs a
  cycle of refinement, not control. Auto-restart has the **same precondition as the controller's**:
  an external supervisor (a Docker `restart:` policy plus a healthcheck), a deployment
  responsibility, not self-supervision ([P3-AVAIL-1](../../artifacts/non-functional-requirements.md)).
- **Degrade fallback — extend, else hold the baseline.** Several paths hold a cycle rather than plan:
  the [state-change gate](./04-spec-optimizer-planning.md#invocation-strategy) skipping the LLM, the
  [input gate](./07-spec-optimizer-input-gating.md) failing, a
  [twin divergence](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity), a cycle **timeout**
  (below), or an LLM backend outage with no fallback
  ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)). Each **extends the last accepted
  plan** — carrying its retained setpoint trajectory forward. When **no plan has ever been accepted** —
  a cold-started service before its first successful cycle, or the first cycle after a restart cleared
  the in-memory trajectory — there is nothing to extend, so the fallback **degenerates to holding the
  Phase 2 baseline**: the current setpoints Phase 2 already holds, which are *always* available even
  with no optimizer plan. Nothing is applied, the greenhouse runs on the crop-profile / operator
  baseline, and the path's canonical [reason code](./10-spec-optimizer-interfaces.md#escalation-reason-codes)
  is surfaced — the universal **surfaced, not applied** invariant
  ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)). A first cycle that fails this way
  costs a cycle of refinement, never control.
- **Fail-fast configuration validation.** Config ([configuration](./11-spec-optimizer-configuration.md))
  is validated **on startup**; an invalid config **blocks the service from coming up** rather than
  letting it run on silent defaults — the same startup-gate discipline the platform applies to schema
  migrations ([08-spec-platform-operations.md](../platform/08-spec-platform-operations.md)). Validation covers
  presence and ranges (thresholds in `[0, 1]`, positive intervals and horizons, a reachable Phase 2
  endpoint, a known LLM provider — the default local Ollama backend needs no credentials, a cloud
  provider requires an API key — and a **pinned model id matching the
  [evaluation](./08-spec-optimizer-evaluation.md) baseline**). Because the active model id pins
  the regression baselines ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)), a config
  that changes it without the corresponding ADR entry and baseline recapture is a reviewable event, not
  silent drift.
- **Escalation backpressure.** Escalations are the optimizer's only operator-facing output for held
  cycles, each tagged with a canonical [reason code](./10-spec-optimizer-interfaces.md#escalation-reason-codes)
  ([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application),
  [input gating](./07-spec-optimizer-input-gating.md),
  [twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
  [write-path concurrency](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation)).
  A persistent fault — a stuck sensor failing the
  [input gate](./07-spec-optimizer-input-gating.md) every cadence, say — is **rate-limited and
  deduplicated** within `service.escalation_dedup_window_minutes`
  ([configuration](./11-spec-optimizer-configuration.md)) into a single **standing** escalation with a
  recurrence count and last-seen time, rather than one fresh escalation per cycle. This is the same
  damping the platform uses for recurring drift
  ([crop-profiles §3](../platform/05-spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)):
  it bounds operator load — the escalation-backlog failure mode — without dropping signal.
- **Health & cadence watchdog.** The FastAPI surface ([interfaces](./10-spec-optimizer-interfaces.md))
  exposes a health endpoint reporting Phase 2 reachability, LLM backend reachability, the
  last-successful-cycle time, and the current escalation backlog, so a supervisor can restart an
  unresponsive container and an operator can see a stalled loop. (The optimizer holds **no** DB
  connection — it reads Phase 2 over REST per [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) — so there is no DB reachability to report.) The same surface exposes a Prometheus **`/metrics`** endpoint
  ([tech stack §Observability](./12-spec-optimizer-tech-stack.md#observability)) — last-successful-cycle
  age, cycle duration, twin divergence, and planner-failover counts make the same stall/overrun
  conditions graphable and alertable in the platform's shared Grafana, not just pollable point-in-time. A cycle that overruns its cadence — LLM latency past the
  [P3-PERF-2](../../artifacts/non-functional-requirements.md) bound, or a hung read — is **timed out**
  (`service.cycle_timeout_seconds`, [configuration](./11-spec-optimizer-configuration.md)) and the
  current plan extended — or, with no prior plan, the Phase 2 baseline held (the degrade fallback above)
  ([P3-PERF-2](../../artifacts/non-functional-requirements.md)): the cadence is a
  ceiling, not a best-effort target, and the loop self-heals to the next tick rather than wedging.
