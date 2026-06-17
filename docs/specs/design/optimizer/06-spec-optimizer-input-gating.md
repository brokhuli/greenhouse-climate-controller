# Optimizer — Input Data Quality & Freshness Gating

> **Purpose:** Define the input precondition the Data Access component runs **before**
> the digital twin and planner are invoked — freshness, completeness, sensor/actuator
> health, and identity consistency — so the optimizer degrades rather than plans a
> confident plan over stale, incomplete, or faulted telemetry.

Part of the [optimizer set](./01-spec-optimizer-overview.md); this is the guardrail on
the planner's **input**, complementing the output guardrails in
[constraints & application](./05-spec-optimizer-constraints-and-application.md).

---

Every other guardrail in this spec validates the planner's **output** — the constraint engine
([constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
and the confidence gate
([application gate](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application))
reject a plan that is out of bounds or low-confidence. Nothing yet validates its **input**. A stale,
incomplete, or sensor-faulted telemetry window produces a confident plan over garbage that can still
pass every output check. This section closes that gap with an input precondition the Data Access
component runs **before** the digital twin and planner are invoked.

The gate checks three things:

| Check | Rule |
|---|---|
| **Freshness** | The latest reading for each required metric is no older than `max_telemetry_age_minutes` ([configuration](./10-spec-optimizer-configuration.md)). Age is computed from the reading's `ts`. |
| **Completeness** | All `required_metrics` are present, and the history window contains at least `min_history_coverage` of its expected samples — a window pocked with large gaps is not a basis for simulation. |
| **Sensor / actuator health** | Inputs are untrusted if a metric the plan depends on is faulted or the controller is degraded — read from the signals the controller already publishes: the `system-state` snapshot's active-fault array and controller `mode` (normal / degraded / interlock), per-sensor fault events (`stuck`, `out_of_range`, `sensor_disagreement`, `temperature_unavailable`), and actuator-state `health` (`ok` / `stuck` / `no_response`). |
| **Identity consistency** | Every row Data Access reads carries the `greenhouse_id` it queried for, zone-scoped rows carry a non-null `zone_id` valid for that greenhouse, and every payload's `schema_version` is one the optimizer understands ([RFC-007 identity & envelope](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)). A view returning another greenhouse's rows, a `zone_id` polarity violation, or an unknown `schema_version` means the read surface or a contract has **drifted** — the window is not a trustworthy basis for planning. |

**When the gate fails, the optimizer degrades rather than plans on bad data** — mirroring the
controller's own
[degradation ladder](../controller/spec-controller-sensing.md#5-the-degradation-ladder) ("down a
ladder, never off a cliff"). It does **not** invoke the LLM; it **extends the last accepted plan** —
the same fallback the state-change gate already uses
([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)) — and raises an **escalation**
surfaced for operator review, traced by `optimizer_run_id`
([P3-OBS-1](../../artifacts/non-functional-requirements.md)). The escalation carries a **reason code**,
because the three checks fail for different reasons: a freshness or completeness miss is **transient**
— it may clear on the next cycle once readings return — but an **identity-consistency** failure is a
deployment or contract fault that **will not self-heal**, so it is tagged as contract drift for the
operator to fix rather than a "wait for sensors" hold. Because the Phase 2 static crop-profile
baseline stays in force regardless ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)), a held
cycle never destabilizes control — it only forgoes refinement until trusted inputs return.

> **Read-surface note (follow-up).** The optimizer can compute every signal above today from existing
> contracts — `ts` on each reading for age, plus the controller's fault-event and `system-state`
> streams for health. Exposing per-metric last-update age and fault status **directly on the RFC-008
> telemetry views** would let the gate read them as plain columns and is the clean long-term home;
> which columns the views carry is an open question on
> [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) (exact view
> set) to resolve when the read surface is authored.
