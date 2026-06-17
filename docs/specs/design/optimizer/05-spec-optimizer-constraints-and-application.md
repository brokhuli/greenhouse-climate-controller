# Optimizer — Constraints, Application & Write Path

> **Purpose:** Define the guardrails on the planner's **output** — the deterministic
> constraint engine, the auto-apply / escalation gate that decides what reaches the
> greenhouse, and how the optimizer cooperates as one of several writers to a
> greenhouse's intended state through the Phase 2 setpoint API.

Part of the [optimizer set](./01-spec-optimizer-overview.md); these gates sit
downstream of the [planner](./04-spec-optimizer-planning.md) and upstream of the
Phase 2 platform that owns intended state.

---

## 1. Constraint engine & safety

Every candidate plan passes through a deterministic **constraint engine** before it can be applied.
The engine validates the plan against:

- **Crop-safe bounds** — the min/max envelope the active crop profile defines for each target; the
  optimizer may move targets *within* this envelope but never outside it.
- **Physical limits** — actuator ranges, rate limits, and physically achievable setpoint combinations.

A plan that clears the engine is eligible for **auto-apply**
([application gate](#2-setpoint-refinement--application)); a plan that violates any bound is **never
applied** — it is rejected and escalated.

Safety is **layered and the controller is final**. The optimizer's constraint engine is an *advisory*
pre-filter on intended targets; it does **not** replace or override the Phase 1 controller's safety
interlocks, which remain controller-owned, run unconditionally on the live system, and are never
reachable by Phase 3
([P1 spec](../controller/02-spec-controller-architecture.md#2-the-tick-pipeline)). Because the optimizer
writes only setpoints — never actuator commands — the controller's interlocks and actuator
constraints still bound everything that actually happens in the greenhouse.

---

## 2. Setpoint refinement & application

What Phase 3 adjusts are **targets**: the VPD / DLI / CO₂ / temperature setpoints that Phase 2 already
resolves from the crop profile. It refines them dynamically — shifting within the crop-safe envelope
to anticipate the diurnal cycle, coordinate actuators, and reduce cost — and writes the result down.
It **writes targets only**; it never commands actuators and never edits the crop profile itself.

**Delivery is through Phase 2.** The optimizer applies a refined setpoint bundle via the **Phase 2
REST API**, layered on the crop-profile baseline exactly as a sticky operator setpoint edit is
([P2 crop profiles — Resolution and the write path](../platform/spec-platform-crop-profiles.md)).
Phase 2 is the **single authority for controller setpoints**
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
it enforces crop-safe bounds, records provenance (source `optimizer`, with an `optimizer_run_id` for
tracing), and is the sole delivery path to the controller — applying on change, re-asserting on
reconnect, and detecting drift. The optimizer submits refined targets via
`POST /greenhouses/{id}/setpoints` and either receives `202` (accepted) or `422` (rejected with the
violated bound); it does **not** write to controllers directly and does **not** publish actuator
commands.

**Application gate — auto-apply within bounds:**

| Plan outcome | Action |
|---|---|
| Passes constraint engine **and** meets the confidence threshold | **Auto-applied** via the Phase 2 REST API |
| Fails the constraint engine (out of crop-safe / physical bounds) | **Not applied** — escalated to an operator |
| Below the confidence threshold | **Not applied** — escalated to an operator |

Escalations are **surfaced, not executed**: the optimizer exposes the proposed plan and the reason it
was held for an operator to review, rather than applying a plan it cannot vouch for. The
within-bounds / confidence thresholds are configuration ([configuration](./10-spec-optimizer-configuration.md)).

---

## 3. Write-path concurrency & reconciliation

[The application gate](#2-setpoint-refinement--application) above describes the happy write path
(`202` / `422`); it does not say how the optimizer behaves as **one of several writers** to a
greenhouse's intended state — alongside operators and its own successive cycles — nor what it does
when a write is rejected. Phase 2 already provides the hard guarantees (single authority, idempotent
last-write-wins, drift detection;
[crop-profiles §3](../platform/spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)).
This section states how the optimizer **cooperates** with them rather than re-implementing them.

| Rule | Behavior |
|---|---|
| **Single-flight per greenhouse** | At most one cycle is in flight per greenhouse. The fixed cadence ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)) plus a per-greenhouse in-flight guard means a slow cycle (LLM latency near the [P3-PERF-2](../../artifacts/non-functional-requirements.md) 60 s bound) finishes or times out **before** the next begins — there is never an optimizer-vs-optimizer race on the write path. N greenhouses still plan independently ([P3-SCAL-1](../../artifacts/non-functional-requirements.md)); single-flight is **per greenhouse, not global**. |
| **The operator wins; the optimizer observes** | At each cycle's start, Data Access reads current setpoints **and their provenance** ([architecture](./02-spec-optimizer-architecture.md)). If the live setpoints carry a non-`optimizer` source (a `manual_override`) newer than the optimizer's last applied plan, the optimizer adopts that as its **baseline** and plans from it — it never re-asserts its own prior plan over an operator edit. A refinement is a suggestion layered on the baseline, never a claim of ownership — the optimizer-layer analog of the platform's "drift is surfaced, not fought indefinitely" ([crop-profiles §3](../platform/spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)). |
| **A `422` is a contract signal, not a retry** | Because the constraint engine ([constraint engine](#1-constraint-engine--safety)) validates against the same crop-safe bounds Phase 2 enforces, a `202` is expected; a `422` means the optimizer's view of the bounds **disagrees** with Phase 2's — the crop profile changed mid-cycle, or the bounds contract drifted. A `422` is therefore **never retried in a loop**: it is escalated as a bounds-mismatch fault (`optimizer_run_id`, [P3-OBS-1](../../artifacts/non-functional-requirements.md)) and the cycle abandoned, leaving the Phase 2 baseline in force ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)). |

Each applied bundle carries its `optimizer_run_id` as provenance
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)),
and Phase 2's setpoint `PATCH` is an idempotent merge
([crop-profiles §3](../platform/spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)),
so a re-assert or a duplicate delivery **re-converges to the same intended state** rather than
stacking — correctness depends only on the last write landing, never on a write landing exactly once.
