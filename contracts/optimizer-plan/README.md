# Optimizer Plan Contract

The structured plan the Phase 3 LLM planner emits, and the record the optimizer service wraps around
it — the single shape the planner, constraint engine, applier, service API, and tests all conform to.
This is an **internal** contract (planner → constraint engine → applier, all inside the optimizer
service), not a cross-service wire boundary: the only downward wire is Phase 2's unchanged
[setpoint write path](../optimizer-write-rest/). JSON Schema, Draft 2020-12.

Prose definition and rationale: [`docs/specs/design/optimizer/05-spec-optimizer-plan-contract.md`](../../docs/specs/design/optimizer/05-spec-optimizer-plan-contract.md).
Catalogued in [`spec-contracts.md §2.6`](../../docs/specs/design/spec-contracts.md#26-optimizer-plan-schema); governed by
[RFC-004](../../docs/decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface).

## Two layers

| Schema | Written by | Purpose |
|---|---|---|
| [`optimizer-plan.schema.json`](./optimizer-plan.schema.json) — `OptimizerPlan` | the LLM (`.with_structured_output`) | The refined plan itself — the horizon `trajectory`, the `immediate_setpoints` bundle applied this cadence, a load-bearing `confidence`, an `explanation`, and optional advisory `objective_scores` / `escalation_hint`. **Proposed, not authoritative.** |
| [`plan-record.schema.json`](./plan-record.schema.json) — `PlanRecord` | the optimizer service | The envelope around one `OptimizerPlan` for one cycle: `optimizer_run_id`, `greenhouse_id`, `created_at`, the chosen `horizon` window, the `backend` that produced it, and the gate `outcome`. Returned by `GET .../plans/latest`; referenced by escalations. |

[`setpoints.schema.json`](./setpoints.schema.json) is a **local copy** of the platform `Setpoints` /
`SetpointsPatch` shape (self-contained-contract convention; mirrors
[`optimizer-write-rest`](../optimizer-write-rest/)). The plan carries a `SetpointsPatch` as
`immediate_setpoints` and on every trajectory point.

The layers are kept separate so `.with_structured_output()` stays honest: the schema the model is
asked to fill contains only fields it can meaningfully author — never a run id, a model name, or an
apply/escalate decision.

## Field reference

Full field tables are in the [spec doc](../../docs/specs/design/optimizer/05-spec-optimizer-plan-contract.md);
each schema's `description`s carry the per-field detail. In brief:

- `confidence` gates auto-apply vs escalation (below the configured `confidence_threshold`, default
  `0.8`, the plan is escalated, not applied).
- `objective_scores` and `escalation_hint` are **advisory / explainability only** — never consumed by
  the gate.
- `outcome.reason_code` (on escalation) is one of the canonical
  [escalation reason codes](../../docs/specs/design/optimizer/10-spec-optimizer-interfaces.md#escalation-reason-codes);
  the raising gate assigns it, not the model.

## Consuming the schemas

Each schema embeds a stable `$id` under `https://greenhouse.local/contracts/optimizer-plan/…`; cross-file
`$ref`s use those `$id`s so they resolve offline (the same base the MQTT/WS schemas use). `PlanRecord`
`$ref`s `OptimizerPlan`, and both `$ref` the local `SetpointsPatch`.

## Fixtures

[`examples/`](./examples/) is exercised by the contract harness
([`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs), `npm run validate:contracts`):
each `<frame>.*.json` validates against `<frame>.schema.json`, and every `*.bad-*.json` must be
rejected.

- `plan-record.applied.json`, `plan-record.escalated-low-confidence.json` → `plan-record.schema.json`
- `optimizer-plan.json` → `optimizer-plan.schema.json`
- `optimizer-plan.bad-confidence.json` → `optimizer-plan.schema.json` (confidence out of `[0, 1]`; **must reject**)

## Versioning

`schema_version` is internal and tracks the optimizer's own code, not a cross-service wire version.
Additive, backward-compatible changes do not bump it; a breaking change bumps it and is recorded in an
ADR under RFC-004 (per [`contracts/README.md`](../README.md)). Phase 4 **extends** the plan to be
combustion-aware (device-selection preferences) without changing these layers.
