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
Constraint Engine                    ← validates against crop-safe bounds + physical limits
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
| Data Access | Read historical telemetry, actuator states, current setpoints, and data-quality/freshness signals for one greenhouse from Phase 2's REST API; never writes. Runs the input data-quality / freshness gate ([input gating](./06-spec-optimizer-input-gating.md)) before planning |
| Digital Twin / Simulation | Roll heat / humidity / CO₂ / VPD / DLI forward over the planning horizon under the current baseline setpoints (see [cycle order](#cycle-order-simulate-then-plan)) |
| LLM Planner | Propose refined setpoint trajectories from the simulated trajectory and objectives, accounting for actuator coupling without issuing actuator commands |
| Constraint Engine | Validate every candidate plan against crop-safe bounds and physical limits before it can be applied |
| Plan Applier | Write within-bounds plans down via the Phase 2 REST API; route the rest to operator escalation |
| Service / API | FastAPI surface for triggering cycles, inspecting plans, and exposing escalations; service config & health |

The optimizer is a **client** of Phase 2, not a peer of Phase 1: it reads history through Phase 2's
optimizer read API and writes through Phase 2's setpoint API exactly as an operator edit would,
layered on the crop-profile baseline ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md)).

### Cycle order: simulate then plan

The twin and planner are **not** mutually recursive within a cycle; the order is fixed. The twin first
simulates the **baseline** trajectory — the current Phase 2 setpoints ([write-path §3 baseline adoption](./05-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation))
carried forward over the horizon under the twin's model. The [planner](./04-spec-optimizer-planning.md)
consumes *that* trajectory (plus bounds and objectives) and proposes a candidate setpoint trajectory. The
[constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety) then
validates the candidate's **targets** against crop-safe and physical bounds, and the
[application gate](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
applies only the immediate next bundle. **Phase 3 v1 does not re-simulate the planner's candidate
trajectory** — it validates the proposed targets against bounds, not by rolling the candidate forward
through the twin. Closed-loop candidate re-simulation (scoring a candidate by simulating it) is a deferred
optimization enhancement ([scope](./12-spec-optimizer-scope.md)).
