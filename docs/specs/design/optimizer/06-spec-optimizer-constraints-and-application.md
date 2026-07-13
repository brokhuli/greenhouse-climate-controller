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
The engine validates the setpoints the optimizer would write — the `immediate_setpoints` bundle, and
`trajectory[0]` as its first step ([plan contract](./05-spec-optimizer-plan-contract.md)) — against the
**two checks it can make deterministically from data already in hand**: the crop-safe bounds delivered
in the planning context, and the bundle itself. It has no actuator model and no reachability oracle, so
these two are the whole of it:

- **Crop-safe range** — the min/max envelope the active crop profile stage defines for each scalar
  climate target and, uniformly across zones, the numeric per-zone irrigation targets (`StageBounds`,
  including its `zones` envelope, on the profile — [platform crop-profiles §1](../platform/05-spec-platform-crop-profiles.md#1-profiles-and-assignment)),
  read from the [planning-context](./07-spec-optimizer-input-gating.md) `setpoints.bounds` **when
  present**; the optimizer may move a target *within* its envelope but never outside it. Because
  Phase 2 enforces the same envelope on the write path, this engine is the optimizer's local pre-filter
  on the authoritative bounds, not a second definition of them (a `202`/`422` disagreement is handled in
  [§3](#3-write-path-concurrency--reconciliation)).
  **Bounds are optional, and absence is a legal state — not [contract drift](./10-spec-optimizer-interfaces.md#escalation-reason-codes).**
  The read contract makes `bounds` absent "when the stage defines none"
  ([optimizer-read-rest](../../../../contracts/optimizer-read-rest/README.md)), and a `StageBounds` may
  **omit any per-field bound** — but a *present* `Bound` always carries **both** `min` and `max` (the
  read contract requires both, and the platform enforces both sides on the write path). The optimizer
  reads absence as *no envelope to refine within* and **holds that target's baseline**: a target with no
  per-field bound is left unrefined, and if the whole `bounds` object is absent, no target is refined
  this cycle — the optimizer holds the entire baseline and records a benign `extended` (no new
  application), **not** an escalation. Holding an unbounded target is safe because Phase 2's write-path bounds
  enforcement remains the backstop for anything that *is* written.
- **Bundle self-consistency** — cross-field invariants that hold with no physical model, checkable from
  the bundle alone: `humidity_low_pct ≤ humidity_high_pct`, each zone's
  `moisture_low_threshold ≤ moisture_high_threshold`, a well-formed day window (`day_start` before
  `day_end`), and non-negative durations (`drain_period_secs`). This is the only sense in which the
  engine judges "achievable combinations" — a bundle whose own fields contradict each other is rejected
  before it can be written, independent of physics.

**Structural precondition — `immediate_setpoints` ≡ `trajectory[0].setpoints`.** The contract defines
`immediate_setpoints` as the refined targets of `trajectory[0]` ([plan contract §2](./05-spec-optimizer-plan-contract.md#2-optimizerplan--the-planners-structured-output));
JSON Schema cannot express that cross-field relationship, so the engine enforces it deterministically in
service code — the two must be **field-for-field equal** on the patched fields (same keys, same values,
zones matched by `zone_id`). A mismatch is a malformed plan: the applied bundle would diverge from the
trajectory the state-change gate and the evaluation suite reason about, so it is rejected and escalated
as a `constraint_violation`, never written.

A plan that clears both checks and this precondition is eligible for **auto-apply**
([application gate](#2-setpoint-refinement--application)); a plan that violates any is **never
applied** — it is rejected and escalated.

**What the engine does not validate — and why.** Actuator ranges, slew / rate limits, and hardware
interlocks are **controller-owned by construction**. The optimizer writes climate *targets*, never
actuator commands, so the Phase 1 controller HAL is what clamps every actuator to its range, ramps it
within its slew limit, and runs the interlocks — unconditionally, on the live system, and never
reachable by Phase 3 ([P1 spec](../controller/02-spec-controller-architecture.md#2-the-tick-pipeline)).
The engine cannot see actuator authority and does not try to. (The CO₂ vent-interlock *threshold*,
`co2_vent_interlock_threshold_pct`, is itself a setpoint the optimizer may move within its crop-safe
bound — but *enforcing* the interlock is the controller's job, not the engine's.) Whether a target is
*thermodynamically reachable* — achievable given actuator authority and the day's disturbances — is
likewise **not** checked in v1: that would require re-simulating the planner's candidate through the
digital twin, which is deferred (the twin simulates the *baseline* forward, not the candidate —
[scope](./13-spec-optimizer-scope.md)). Reachability surfaces indirectly instead — an unattainable
target shows up as twin divergence / fidelity drift ([digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity)),
or as the next cycle re-planning from the observed baseline ([§3](#3-write-path-concurrency--reconciliation)).

Safety is thus **layered and the controller is final**: the constraint engine is an *advisory*
pre-filter on intended targets, and because everything the optimizer emits is a setpoint, the
controller's interlocks and actuator constraints still bound everything that actually happens in the
greenhouse.

This engine gates the planner's **output**. Input *trustworthiness* — telemetry freshness and
completeness, sensor and actuator health, `controller_mode`, and clock mode — is a separate concern
handled **upstream** by the input gate before the planner ever runs
([input gating](./07-spec-optimizer-input-gating.md)); the constraint engine assumes inputs already
cleared that gate and does not re-check health.

---

## 2. Setpoint refinement & application

What Phase 3 adjusts are **targets**: the VPD / DLI / CO₂ / temperature setpoints and the per-zone
irrigation targets that Phase 2 already resolves from the crop profile. It refines them dynamically — shifting within the crop-safe envelope
to anticipate the diurnal cycle, coordinate actuators, and reduce cost — and writes the result down.
It **writes targets only**; it never commands actuators and never edits the crop profile itself.

**Delivery is through Phase 2.** The optimizer applies a refined setpoint bundle via the **Phase 2
REST API**, layered on the crop-profile baseline exactly as a sticky operator setpoint edit is
([P2 crop profiles — Resolution and the write path](../platform/05-spec-platform-crop-profiles.md)).
Phase 2 is the **single authority for controller setpoints**
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
it enforces crop-safe bounds, records provenance (source `optimizer`, with an `optimizer_run_id` for
tracing), and is the sole delivery path to the controller — applying on change, re-asserting on
reconnect, and detecting drift. The optimizer submits refined targets via
`POST /api/greenhouses/{id}/setpoints`; the expected outcomes are `202` (accepted) and `422` (rejected
with the violated bound), with the full response set — auth, missing greenhouse, controller-offline, and
transport failures — handled in [Write outcomes](#write-outcomes) below. It does **not** write to
controllers directly and does **not** publish actuator commands. The call is trusted on the local network by default; under the platform's hardened
`SERVICE_AUTH_MODE=oidc` posture it carries a Keycloak `setpoints:write` service token
([interfaces — authenticating the Phase 2 write path](./10-spec-optimizer-interfaces.md#authenticating-the-phase-2-write-path),
[RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)),
with no change to the bundle or the `202`/`422` contract.

**Application gate — auto-apply within bounds:**

| Plan outcome | Action |
|---|---|
| Passes constraint engine **and** meets the confidence threshold | **Auto-applied** via the Phase 2 REST API |
| Fails the constraint engine (out of crop-safe range, or an inconsistent setpoint bundle) | **Not applied** — escalated to an operator |
| Below the confidence threshold | **Not applied** — escalated to an operator |

Escalations are **surfaced, not executed**: the optimizer exposes the proposed plan and the reason it
was held for an operator to review, rather than applying a plan it cannot vouch for. The
within-bounds / confidence thresholds are configuration ([configuration](./11-spec-optimizer-configuration.md)).

### Write outcomes

The application gate above decides *whether* to write; this table defines how the optimizer treats
*each* response the [write path](../../../../contracts/optimizer-write-rest/paths/setpoints.json) can
return, so no status is silently unhandled. A held write never mutates intended state — the Phase 2
baseline stays in force ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)) — and every held
cycle carries a canonical [reason code](./10-spec-optimizer-interfaces.md#escalation-reason-codes).

| Response | Meaning | Optimizer behavior | Outcome · reason code |
|---|---|---|---|
| `202 Accepted` | Recorded as intended state — delivered to the controller, or held for one that is offline. | The refinement landed. | `applied` |
| `503 Service Unavailable` | Phase 2 **recorded** the intended state but could not reach the controller at write; it re-asserts on reconnect — "retry is not required" ([contract](../../../../contracts/optimizer-write-rest/components/responses.json)). | The refinement landed in the single authority; controller delivery is Phase 2's to complete. | `applied` (controller-offline noted) |
| `422 Unprocessable` | The optimizer's view of the bounds disagrees with Phase 2's — the crop profile changed mid-cycle, or the bounds contract drifted. | Never retried in a loop; cycle abandoned ([§3](#3-write-path-concurrency--reconciliation)). | `escalated` · `bounds_mismatch` (persistent) |
| `401 Unauthorized` / `403 Forbidden` | Under `SERVICE_AUTH_MODE=oidc` only: a missing/invalid token, or one lacking the `setpoints:write` role ([authenticating the write path](./10-spec-optimizer-interfaces.md#authenticating-the-phase-2-write-path)). A deployment/credential fault, not a data fault. | Not retried — the same credential cannot succeed. | `escalated` · `write_unauthorized` (persistent) |
| `404 Not Found` | The greenhouse does not exist — the optimizer is configured for one the platform's registry does not hold. | Not retried; an identity/registry mismatch to fix, not a transient miss. | `escalated` · `contract_drift` (persistent) |
| Transport failure (connection refused, timeout, 5xx gateway, no response) | The POST never reached Phase 2's authority, or no confirmation returned — distinct from the well-formed `503` above; the same failure shape as a Phase 2 **read** that cannot reach the platform. | Cycle held and retried next cadence; deduplicated into a standing escalation while it persists ([resilience — escalation backpressure](./09-spec-optimizer-resilience.md)). | `escalated` · `platform_unavailable` (transient) |

---

## 3. Write-path concurrency & reconciliation

[The application gate](#2-setpoint-refinement--application) above describes the happy write path
(`202` / `422`); it does not say how the optimizer behaves as **one of several writers** to a
greenhouse's intended state — alongside operators and its own successive cycles — nor what it does
when a write is rejected. Phase 2 already provides the hard guarantees (single authority, idempotent
last-write-wins, drift detection;
[crop-profiles §3](../platform/05-spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)).
This section states how the optimizer **cooperates** with them rather than re-implementing them.

| Rule | Behavior |
|---|---|
| **Single-flight per greenhouse** | At most one cycle is in flight per greenhouse. The fixed cadence ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)) plus a per-greenhouse in-flight guard means a slow cycle (near the [P3-PERF-2](../../artifacts/non-functional-requirements.md) 90 s bound) finishes or times out **before** the next begins — there is never an optimizer-vs-optimizer race on the write path. N greenhouses still plan independently ([P3-SCAL-1](../../artifacts/non-functional-requirements.md)); single-flight is **per greenhouse, not global**. |
| **The operator wins; the optimizer observes** | At each cycle's start, Data Access reads current setpoints **and their provenance** ([architecture](./02-spec-optimizer-architecture.md)). If the live setpoints carry a non-`optimizer` source (an `operator_edit`) newer than the optimizer's last applied plan, the optimizer adopts that as its **baseline** and plans from it — it never re-asserts its own prior plan over an operator edit. A refinement is a suggestion layered on the baseline, never a claim of ownership — the optimizer-layer analog of the platform's "drift is surfaced, not fought indefinitely" ([crop-profiles §3](../platform/05-spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)). |
| **A `422` is a contract signal, not a retry** | Because the constraint engine ([constraint engine](#1-constraint-engine--safety)) validates against the same crop-safe bounds Phase 2 enforces, a `202` is expected; a `422` means the optimizer's view of the bounds **disagrees** with Phase 2's — the crop profile changed mid-cycle, or the bounds contract drifted. A `422` is therefore **never retried in a loop**: it is escalated as a `bounds_mismatch` fault ([reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes); `optimizer_run_id`, [P3-OBS-1](../../artifacts/non-functional-requirements.md)) and the cycle abandoned, leaving the Phase 2 baseline in force ([P3-RESIL-1](../../artifacts/non-functional-requirements.md)). |

Each applied bundle carries its `optimizer_run_id` as provenance
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)),
and Phase 2's setpoint write is an idempotent merge
([crop-profiles §3](../platform/05-spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth)) —
the optimizer's `POST /setpoints` and the operator's ad-hoc `PATCH` share the same merge semantics —
so a re-assert or a duplicate delivery **re-converges to the same intended state** rather than
stacking — correctness depends only on the last write landing, never on a write landing exactly once.
