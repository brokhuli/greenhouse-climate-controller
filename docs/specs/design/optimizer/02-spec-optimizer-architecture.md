# Optimizer — Architecture

> **Purpose:** Define how the optimizer's components fit together into a
> per-greenhouse planning cycle — read history → validate input quality → simulate
> forward → plan → validate → apply — and how it sits as a **client** of the Phase 2
> platform rather than a peer of the Phase 1 controller.

This is the structural map for the [optimizer set](./01-spec-optimizer-overview.md);
each component named below is detailed in its own document.

---

The optimizer runs a planning cycle per greenhouse: read history → **validate input quality** →
simulate forward → plan → validate → apply. It **reads** telemetry directly from Phase 2's time-series
store and **writes** refined setpoints back through the Phase 2 REST API, which remains the single
authority on intended state.

```
Phase 2 TimescaleDB
      │  historical telemetry (read-only)
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
| Data Access | Read historical telemetry, actuator states, and current setpoints for one greenhouse from Phase 2's store; never writes. Runs the input data-quality / freshness gate ([input gating](./06-spec-optimizer-input-gating.md)) before planning |
| Digital Twin / Simulation | Roll heat / humidity / CO₂ / VPD / DLI forward over the planning horizon under candidate setpoints |
| LLM Planner | Propose refined setpoint trajectories from the simulated trajectory and objectives, accounting for actuator coupling without issuing actuator commands |
| Constraint Engine | Validate every candidate plan against crop-safe bounds and physical limits before it can be applied |
| Plan Applier | Write within-bounds plans down via the Phase 2 REST API; route the rest to operator escalation |
| Service / API | FastAPI surface for triggering cycles, inspecting plans, and exposing escalations; service config & health |

The optimizer is a **client** of Phase 2, not a peer of Phase 1: it reads from Phase 2's history and
writes through Phase 2's setpoint API exactly as an operator edit would, layered on the crop-profile
baseline ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md)).
