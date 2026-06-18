# Optimizer — Scope: Deferred / Out of Scope

> **Purpose:** State the capabilities intentionally **not** in Phase 3 and where each
> belongs — the boundary that keeps the optimizer a per-greenhouse, setpoint-only
> refinement layer and defers weather-reactive, site-wide, and safety-authority
> concerns to other phases.

Part of the [optimizer set](./01-spec-optimizer-overview.md); several of these defer to
[Phase 4](../spec-phase4.md).

---

Optimizer capabilities intentionally **not** in Phase 3:

| Deferred / excluded                             | Why / where it belongs                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weather / forecast-reactive control             | Reacting to a live + forecast outdoor feed (cold fronts, clouds) needs a weather source and stochastic planning — **Phase 4** ([spec-phase4.md](../spec-phase4.md)). Phase 3 anticipates only clock-known disturbances ([digital twin](./03-spec-optimizer-digital-twin.md#1-the-forward-model)) |
| Combustion-heater coordination                  | A single actuator coupling temperature + CO₂ + humidity breaks the independence the control loops assume and needs dedicated multi-variable coordination — **Phase 4** ([P1 constraints §9](../controller/10-spec-controller-constraints.md#9-scope--deferred-controller-capabilities))          |
| Site-wide orchestration                         | Coordinated behavior across greenhouses (staggering loads, sharing constrained resources) needs a shared-infrastructure model that is out of scope; Phase 3 plans **one greenhouse at a time** ([overview](./01-spec-optimizer-overview.md))                                                     |
| Introducing the crop → targets mapping          | The static "this crop, this stage → these targets" mapping is **owned by Phase 2** ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md)); Phase 3 only **refines** within its crop-safe bounds                                                                                     |
| Direct actuator commanding                      | Driving individual actuators is **controller-owned** ([P1 spec](../controller/02-spec-controller-architecture.md#2-the-tick-pipeline)); Phase 3's downward influence is **setpoint-only**, through Phase 2                                                                                       |
| Safety authority                                | Safety interlocks remain **controller-owned** and unconditional; the optimizer's constraint engine is an advisory pre-filter and never overrides them ([constraint engine](./05-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))                                      |
| Writing directly to controllers                 | Phase 2 is the single authority on intended state; the optimizer writes refined setpoints **through the Phase 2 API**, never straight to a controller ([setpoint application](./05-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application))                            |
| Twin auto-recalibration / parameter auto-tuning | Phase 3 **detects and flags** parameter drift ([twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity)) and attenuates confidence; refitting the twin's physical parameters from history needs a calibration / system-identification loop that is out of scope here        |
| Service-token auth on the write path            | The optimizer → Phase 2 write path is unauthenticated by decision ([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) local trust model); provenance is **self-asserted**, not token-backed — hardening this boundary is deferred  |
```
