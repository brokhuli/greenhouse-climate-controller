# Optimizer — Architecture

> **Purpose:** Define how the optimizer's components fit together into a
> per-greenhouse planning cycle — read history → validate input quality → simulate
> forward → plan → validate → apply — and how it sits as a **client** of the Phase 2
> platform rather than a peer of the Phase 1 controller.

This is the structural map for the [optimizer set](./01-spec-optimizer-overview.md);
each component named below is detailed in its own document.

---

The optimizer runs a planning cycle per greenhouse: read history → **validate input quality** →
simulate forward → plan → validate → apply. It **reads** telemetry through the Phase 2 REST API,
whose handlers are backed by platform-owned SQL views or aggregates, and **writes** refined setpoints
back through the Phase 2 REST API, which remains the single authority on intended state.

```
Phase 2 REST API
      │  planning context / historical telemetry (read-only)
      ▼
Data Access                          ← loads recent readings, actuator states, current setpoints
      │
      ▼
Input-Quality Gate                   ← freshness / completeness / sensor-health precondition
      │  inputs trusted         │  stale / incomplete / faulted
      ▼                         ▼
      │                   Operator Escalation (current plan extended)
      │  observed state + baseline
      ▼
Digital Twin / Simulation            ← rolls climate forward over the planning horizon
      │  predicted trajectory
      ▼
LLM Planner                          ← proposes refined setpoint trajectories
      │  candidate plan
      ▼
Constraint Engine                    ← validates crop-safe range + bundle consistency
      │  within bounds          │  out of bounds / low confidence
      ▼                         ▼
Plan Applier              Operator Escalation
  │  refined setpoints           │  surfaced, not applied
  ▼                             ▼
Phase 2 REST API ──────────► (operator review)
      │  reconciles intended state
      ▼
Phase 1 Controller
```

| Component | Responsibility |
|---|---|
| Data Access | Read historical telemetry, actuator states, current setpoints, and data-quality/freshness signals for one greenhouse from Phase 2's REST API; never writes. Runs the input data-quality / freshness gate ([input gating](./07-spec-optimizer-input-gating.md)) before planning |
| Digital Twin / Simulation | Roll heat / humidity / CO₂ / VPD / DLI forward over the planning horizon under the current baseline setpoints (see [cycle order](#cycle-order-simulate-then-plan)) |
| LLM Planner | Propose refined setpoint trajectories from the simulated trajectory and objectives, accounting for actuator coupling without issuing actuator commands |
| Constraint Engine | Validate every candidate plan against crop-safe range and bundle consistency before it can be applied |
| Plan Applier | Write within-bounds plans down via the Phase 2 REST API; route the rest to operator escalation |
| Service / API | FastAPI surface for operator-triggered on-demand cycles, model selection, plan inspection, and escalation review; service config & health. Schedules the fixed-cadence cycles — **concurrently across greenhouses**, bounded by `max_concurrent_cycles`, single-flight per greenhouse — and gates the whole loop on the `enabled` flag (read-only mode when off) |

The optimizer is a **client** of Phase 2, not a peer of Phase 1: it reads history through Phase 2's
optimizer read API and writes through Phase 2's setpoint API exactly as an operator edit would,
layered on the crop-profile baseline ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md)).

### Scheduling: concurrent, per greenhouse, single-flight

A planning cycle is **scoped** to one greenhouse — "a planning cycle per greenhouse" describes what one
cycle covers, **not** serial processing of the fleet. The Service dispatches the fixed-cadence cycles for
the N greenhouses **concurrently**, so a slow cycle on one greenhouse does not delay the others and
aggregate fleet cycle time does not grow linearly with N ([P3-SCAL-1](../../artifacts/non-functional-requirements.md),
[P3-PERF-1](../../artifacts/non-functional-requirements.md)). Concurrency is bounded by
`max_concurrent_cycles` ([configuration](./11-spec-optimizer-configuration.md)) — a worker-pool ceiling that
keeps the shared LLM backend and the Phase 2 API from being stampeded — and the **single-flight-per-greenhouse**
guard still holds: parallelism is **across** greenhouses, while within any one greenhouse at most one cycle
is ever in flight ([constraints §3](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation)).
The whole scheduler is gated on the service [`enabled`](./11-spec-optimizer-configuration.md) flag: while the
optimizer is **disabled** (read-only mode) it dispatches no cycles and the Plan Applier is inert — no
setpoint write leaves the service — though every read surface stays live
([resilience](./09-spec-optimizer-resilience.md)). Each tick the scheduler also **skips any greenhouse the
operator has individually disabled** via the per-greenhouse `enabled` flag
([interfaces](./10-spec-optimizer-interfaces.md#service-api-endpoints)): a greenhouse is dispatched only when
the service is globally enabled *and* that greenhouse is enabled (global pause takes precedence), so one
greenhouse can be paused while the rest of the fleet plans on cadence.

Operators may also request an **on-demand** cycle for one greenhouse through the Service API
([interfaces](./10-spec-optimizer-interfaces.md#service-api-endpoints)). This uses the same single-flight
guard as scheduled work: if that greenhouse already has a cycle in flight the request is refused rather
than queued behind it. An on-demand request runs outside the fixed cadence and asks for a fresh plan, so it
bypasses only the state-change suppression that would otherwise extend a prior plan; it does **not** bypass
the `enabled` gate (service-wide *or* the greenhouse's own per-greenhouse flag — either being off refuses it
with `409`), input-quality gate, twin robustness checks, crop-safe bounds, confidence gate, or Phase 2
write validation. In other words, it is an operator way to say "plan now," not a way to force unsafe output
through the system.

### Cycle order: simulate then plan

The twin and planner are **not** mutually recursive within a cycle; the order is fixed. The twin first
simulates the **baseline** trajectory — the current Phase 2 setpoints ([write-path §3 baseline adoption](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation))
carried forward over the horizon under the twin's model. The [planner](./04-spec-optimizer-planning.md)
consumes *that* trajectory (plus bounds and objectives) and proposes a candidate setpoint trajectory. The
[constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety) then
validates the candidate's **targets** against crop-safe range and bundle consistency, and the
[application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
applies only the immediate next bundle. **Phase 3 v1 does not re-simulate the planner's candidate
trajectory** — it validates the proposed targets against bounds, not by rolling the candidate forward
through the twin. Closed-loop candidate re-simulation (scoring a candidate by simulating it) is a deferred
optimization enhancement ([scope](./13-spec-optimizer-scope.md)).
