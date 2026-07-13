# Optimizer — Plan Contract (OptimizerPlan)

> **Purpose:** Define the structured plan the LLM planner emits and the record the
> optimizer wraps around it — the single shape the planner, constraint engine,
> applier, service API, and tests all conform to, so none of them has to invent its
> own.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the plan is produced by the
[planner](./04-spec-optimizer-planning.md#1-llm-driven-planning) and consumed by the
[constraint engine and applier](./06-spec-optimizer-constraints-and-application.md). The
machine-readable schema lives in
[`contracts/optimizer-plan/`](../../../../contracts/optimizer-plan/) and is catalogued in
[`spec-contracts.md`](../spec-contracts.md#26-optimizer-plan-schema); this document is the prose
definition it conforms to, governed by
[RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface).

---

## 1. Two layers: `OptimizerPlan` vs `PlanRecord`

The plan is defined in **two layers**, because two different producers write it:

- **`OptimizerPlan`** — the **LLM's structured output**, parsed via
  `.with_structured_output(OptimizerPlan)` ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)).
  Everything in it is *proposed by the model*: the refined trajectory, the immediate targets, a
  confidence signal, and a reasoning summary. The LLM has no authority — the plan is only a
  suggestion until the [gates](./06-spec-optimizer-constraints-and-application.md) clear it.
- **`PlanRecord`** — the **optimizer service's envelope** around one `OptimizerPlan` for one cycle.
  It stamps on the provenance and outcome the model must **not** be trusted to invent:
  `optimizer_run_id`, the horizon window the service chose, which backend and
  [prompt version](./04-spec-optimizer-planning.md#prompt-template--versioning) produced the plan, and
  what the gates decided. This is what
  [`GET …/plans/latest`](./10-spec-optimizer-interfaces.md#service-api-endpoints) returns and what an
  [escalation](./10-spec-optimizer-interfaces.md#escalation-reason-codes) references.

Keeping them separate keeps `.with_structured_output()` honest: the schema the LLM is asked to fill
contains only fields it can meaningfully author. The service never asks the model for a run id, a
model name, or an apply/escalate decision.

| Field lives on | Written by | Why |
|---|---|---|
| `OptimizerPlan` | the LLM (one `.invoke()`) | The refined plan itself — proposed, not authoritative. |
| `PlanRecord` | the optimizer service | Provenance, the chosen horizon window, backend identity, and the gate outcome — all known to the service, none safely delegable to the model. |

---

## 2. `OptimizerPlan` — the planner's structured output

Field names are `snake_case` on the wire (the convention every contract follows); the same shape is
the Python `OptimizerPlan` Pydantic model.

| Field | Type | Required | Description |
|---|---|---|---|
| `trajectory` | `TrajectoryPoint[]` (non-empty) | ✓ | The refined setpoint trajectory across the horizon, one point per hour ([hourly granularity](./04-spec-optimizer-planning.md#invocation-strategy)). A **planning artifact**: it is held in memory so a skipped cycle can **extend the plan** ([state-change gate](./04-spec-optimizer-planning.md#invocation-strategy)) — the retained trajectory is **surfaced for review, never re-applied**. On a skipped or held cycle **nothing new is written**: the last applied `immediate_setpoints` bundle **stays in force** (Phase 2 already holds it), so the trajectory is **not** written to Phase 2 — only a fresh, gated plan's `immediate_setpoints` ever reaches the greenhouse. It is **not** the gate's comparison input: the gate diffs the twin's predicted-**climate** forecast, a separate in-memory reference ([digital twin §1.6](./03-spec-optimizer-digital-twin.md#16-twin-output-predicted-trajectory)). |
| `immediate_setpoints` | `SetpointsPatch` | ✓ | The **single next bundle** the applier submits to Phase 2 this cadence — the refined targets of `trajectory[0]` expressed as a partial [setpoints patch](../../../../contracts/optimizer-write-rest/components/schemas/setpoints.json). This is a **normative, engine-enforced invariant** — `immediate_setpoints` ≡ `trajectory[0].setpoints` field-for-field, not just a description — and a mismatch is rejected ([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety)). The one part of the plan that reaches the greenhouse. |
| `confidence` | `number` ∈ [0, 1] | ✓ | The planner's self-assessed confidence in the immediate bundle. **Load-bearing**: below the configured `confidence_threshold` ([configuration](./11-spec-optimizer-configuration.md), default `0.8`) the plan is **escalated, not applied** ([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)). |
| `explanation` | `string` | ✓ | A short natural-language reason summary — the "reasoning/audit trace" surfaced to an operator when the plan is escalated or inspected. |
| `objective_scores` | `{ anticipation, coupling, efficiency }`, each `number` ∈ [0, 1] | – | The planner's self-reported weighting of how each [objective](./04-spec-optimizer-planning.md#2-optimization-objectives) shaped the plan. **Advisory / explainability only** — surfaced for review and telemetry, never consumed by the gate (the gate reads `confidence` and the deterministic constraint engine, not these). |
| `escalation_hint` | `{ reason_code?, note? }` | – | An optional planner self-flag — e.g. a target it deliberately held near a bound. **Advisory only**: the authoritative `reason_code` is assigned downstream by the gate from the [canonical table](./10-spec-optimizer-interfaces.md#escalation-reason-codes), never taken from the model. |

### `TrajectoryPoint`

One hour of the refined trajectory:

| Field | Type | Required | Description |
|---|---|---|---|
| `at` | `string` (RFC 3339, UTC) | ✓ | The instant these targets apply. `trajectory[0].at` is the cycle's start; points are hour-spaced across the [horizon](./04-spec-optimizer-planning.md#invocation-strategy). |
| `setpoints` | `SetpointsPatch` | ✓ | The refined scalar targets at that hour — the VPD / DLI / CO₂ / temperature setpoints and per-zone irrigation targets the optimizer refines within the crop-safe envelope ([what Phase 3 adjusts](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)). |

### `SetpointsPatch`

A partial of the platform's `Setpoints` bundle — the same scalar targets Phase 2 already resolves from
the crop profile (`temperature_day_c`, `temperature_night_c`, the day window, `humidity_*`,
`co2_target_ppm`, `co2_vent_interlock_threshold_pct`, `vpd_target_kpa`, `dli_target_mol`, and the
per-zone `zones[]` irrigation targets). Absent fields are unchanged; zones are matched by `zone_id`.
Per the **self-contained-contract convention**, `contracts/optimizer-plan/` carries a **local copy** of
this shape (as the [write-path contract](../../../../contracts/optimizer-write-rest/) already does)
rather than a cross-contract `$ref`.

---

## 3. `PlanRecord` — the optimizer-service envelope

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `integer` | ✓ | Major version of this plan contract. Internal, not a cross-service wire version; a bump is an ADR event (§5). |
| `optimizer_run_id` | `string` (UUID) | ✓ | The cycle's trace / provenance id. Phase 2 records it on the applied bundle (`source = optimizer`, [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)); every plan and escalation the service exposes is traced by it (`P3-OBS-1`). |
| `greenhouse_id` | `string` | ✓ | The greenhouse this plan is for — one plan is one greenhouse's cycle. |
| `created_at` | `string` (RFC 3339, UTC) | ✓ | When the cycle ran — the instant this record was produced, whether it applied, escalated, or extended. |
| `horizon` | `{ start, end }` (RFC 3339, UTC) | ✓ | The **adaptive window** the service chose for the cycle: 12 h by default, 24 h near a day boundary ([invocation strategy](./04-spec-optimizer-planning.md#invocation-strategy)). `trajectory` spans `[start, end]`. |
| `backend` | `{ provider, model, prompt_version, role }` | ✓ | Which **model and prompt** produced the plan. `provider ∈ { ollama, anthropic, openai }` — fixed per service instance, an [offline change](./11-spec-optimizer-configuration.md); `model` is the **active** id (e.g. `qwen2.5:7b`, `claude-sonnet-4-6`), **operator-mutable at runtime** within the provider's [`available_models`](./11-spec-optimizer-configuration.md) allowlist ([`POST /api/optimizer/model`](./10-spec-optimizer-interfaces.md#service-api-endpoints)) — a switch stamps the new id into the **next** cycle's `backend.model`; `prompt_version` is the pinned [prompt-template version](./04-spec-optimizer-planning.md#prompt-template--versioning) (e.g. `v1`); `role ∈ { primary, fallback }`. `(provider, model, prompt_version, sampling)` is the provenance tuple a plan is reproduced from — a fallback is a **different model** held to its own [evaluation baseline](./08-spec-optimizer-evaluation.md), so failover is recorded here, not hidden ([determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)). |
| `plan` | `OptimizerPlan` \| `null` | ✓ (nullable) | The layer-1 plan (§2), or **`null`** when the cycle produced no new plan — any **pre-planner** held cycle (the input gate, clock-mode, contract-drift, twin-divergence, cycle-timeout, or LLM-unavailable path holds the cycle *before* the planner runs) and a cold-start `extended`. An `applied` record **always** carries a non-null plan (the schema enforces this with a conditional rule); a **post-planner** escalation (`low_confidence`, `constraint_violation`, `twin_fidelity_fault`, `bounds_mismatch`, `write_unauthorized`) still carries the plan it rejected. |
| `source_plan_id` | `string` (UUID) | – | Present when `plan` is `null`: the `optimizer_run_id` of the prior accepted plan whose already-applied bundle **stays in force** while this cycle is held or extended — the greenhouse holds the last applied setpoints, nothing new is written ([resilience](./09-spec-optimizer-resilience.md)). Absent on a cold-start hold of the Phase 2 baseline, where no prior plan exists. |
| `outcome` | `{ status, reason_code?, message? }` | ✓ | What the gates decided. `status ∈ { applied, escalated, extended }`; on `escalated`, `reason_code` (one of the [canonical reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)) is **required** — the schema enforces it with a conditional rule ([plan-record.schema.json](../../../../contracts/optimizer-plan/plan-record.schema.json)) — and `message` is the operator-facing detail. `extended` means **no new plan was applied and nothing new was written**: the [state-change gate](./04-spec-optimizer-planning.md#invocation-strategy) skipped the LLM (or there was nothing to refine), so the **last applied bundle stays in force** — `plan` is `null` and `source_plan_id` names the retained prior plan (absent on a cold-start hold of the Phase 2 baseline). |

**A held cycle still produces a record.** Not every cycle produces a plan: the
[input gate](./07-spec-optimizer-input-gating.md), a
[twin divergence](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity), a cycle timeout, or an
LLM outage can hold a cycle *before* the planner ever runs
([resilience](./09-spec-optimizer-resilience.md)). Such a cycle still emits a `PlanRecord` — the
operator surface must show *that the cycle ran and why nothing changed* — with `plan = null`, the
pre-planner [reason code](./10-spec-optimizer-interfaces.md#escalation-reason-codes) on `outcome`, and
`source_plan_id` naming the plan whose already-applied bundle stays in force (absent on a cold start,
where the Phase 2 baseline is held). The **only** record guaranteed a non-null `plan` is an `applied`
one.

---

## 4. Lifecycle — who produces and consumes each field

1. The **planner** emits an `OptimizerPlan` (`trajectory`, `immediate_setpoints`, `confidence`,
   `explanation`, and the optional advisory fields).
2. The **service** wraps it in a `PlanRecord`, stamping `optimizer_run_id`, `greenhouse_id`,
   `created_at`, `horizon`, and `backend`.
3. The **constraint engine** validates `immediate_setpoints` (and, for regression, `trajectory[0]`)
   against the crop-safe range and bundle consistency, and enforces that the two are equal
   ([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety)).
4. The **application gate** checks `confidence` against the threshold
   ([application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)).
5. On pass, the **applier** submits `immediate_setpoints` via
   `POST /api/greenhouses/{id}/setpoints` carrying `optimizer_run_id`, and records
   `outcome.status = applied`. On any failure the plan is **surfaced, not applied**: `outcome.status
   = escalated` with the gate's `reason_code`, leaving the Phase 2 baseline in force
   ([write path](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation)).
6. The **state-change gate** of the *next* cycle diffs the current twin **climate** forecast against
   the **reference forecast** retained from this cycle's planner run
   ([planning — state-change gate](./04-spec-optimizer-planning.md#invocation-strategy)); a small
   deviation yields `outcome.status = extended` — **no new LLM call and no new write**: the last
   applied bundle stays in force while this plan's `trajectory` is retained in memory (surfaced, not
   re-applied), referenced by the next record's `source_plan_id`.

Beyond the cycle that produces it, a `PlanRecord`'s **retention** is a service concern, not a field the
model or gates author. The `outcome` is **immutable** — it records what the gates decided at cycle time and
is never rewritten by a later resolution. An **escalated** record is retained while its escalation is
**open** and is pruned together with that escalation once it closes (`operator` / `superseded` / `expired`),
except that the **latest** record per greenhouse is always kept so
[`GET …/plans/latest`](./10-spec-optimizer-interfaces.md#service-api-endpoints) never goes empty. The
escalation lifecycle, the periodic sweep, and the retention window are defined in
[resilience — escalation lifecycle & backpressure](./09-spec-optimizer-resilience.md).

---

## 5. Versioning & governance

This is an **internal** contract — planner → constraint engine → applier, all inside the optimizer
service — not a new cross-service wire boundary (the only downward wire is Phase 2's unchanged
[setpoint write path](../../../../contracts/optimizer-write-rest/)). Its `schema_version` therefore
tracks the optimizer's own code, and a breaking change is an ADR event under
[RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface), per
the [contracts convention](../../../../contracts/README.md). Phase 4 **extends** the plan to be
combustion-aware (device-selection preferences on the trajectory) without changing the layers here
([spec-phase4.md](../spec-phase4.md)).

---

## 6. Example

An **applied** `PlanRecord` (trajectory truncated to two points for brevity):

```json
{
  "schema_version": 1,
  "optimizer_run_id": "018f9c2e-6b7a-7c31-9e4d-2a1b5c6d7e8f",
  "greenhouse_id": "gh-04",
  "created_at": "2026-07-11T13:30:00.000Z",
  "horizon": { "start": "2026-07-11T13:30:00.000Z", "end": "2026-07-12T01:30:00.000Z" },
  "backend": { "provider": "ollama", "model": "llama3", "prompt_version": "v1", "role": "primary" },
  "plan": {
    "confidence": 0.91,
    "explanation": "Pre-cool ahead of the 15:00 solar peak; ease VPD up toward the night band.",
    "objective_scores": { "anticipation": 0.9, "coupling": 0.7, "efficiency": 0.5 },
    "immediate_setpoints": { "temperature_day_c": 22.5, "vpd_target_kpa": 1.05 },
    "trajectory": [
      { "at": "2026-07-11T13:30:00.000Z", "setpoints": { "temperature_day_c": 22.5, "vpd_target_kpa": 1.05 } },
      { "at": "2026-07-11T14:30:00.000Z", "setpoints": { "temperature_day_c": 21.8, "vpd_target_kpa": 1.10 } }
    ]
  },
  "outcome": { "status": "applied" }
}
```

An **escalated** `PlanRecord` — the same shape, held for an operator because `confidence` fell below
the threshold:

```json
{
  "schema_version": 1,
  "optimizer_run_id": "018f9c2e-77b0-7a12-8c55-9f0e1d2c3b4a",
  "greenhouse_id": "gh-04",
  "created_at": "2026-07-11T14:00:00.000Z",
  "horizon": { "start": "2026-07-11T14:00:00.000Z", "end": "2026-07-12T02:00:00.000Z" },
  "backend": { "provider": "anthropic", "model": "claude-sonnet-4-6", "prompt_version": "v1", "role": "primary" },
  "plan": {
    "confidence": 0.62,
    "explanation": "Sensor gap left the CO₂ trajectory uncertain; low confidence in the enrichment target.",
    "immediate_setpoints": { "co2_target_ppm": 900 },
    "trajectory": [
      { "at": "2026-07-11T14:00:00.000Z", "setpoints": { "co2_target_ppm": 900 } }
    ]
  },
  "outcome": {
    "status": "escalated",
    "reason_code": "low_confidence",
    "message": "confidence 0.62 < threshold 0.80"
  }
}
```
