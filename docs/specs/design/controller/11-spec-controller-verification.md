# Controller — Verification & Scenario Testing

> **Purpose:** Define the strategy that exercises the controller pipeline and holds its behavior
> stable as the code evolves — the per-stage unit suites, the golden control/safety scenario library
> run through the seeded HAL, the real-time/determinism properties, and the contract-conformance of
> its MQTT + REST surfaces.

Part of the [controller set](./01-spec-controller-overview.md); this is the controller's instance of
the system-wide strategy in [`spec-verification.md`](../spec-verification.md) (the verification
ladder, the tooling matrix, the contract harness) and the optimizer-side analog of
[`07-spec-optimizer-evaluation.md`](../optimizer/07-spec-optimizer-evaluation.md). It builds on the
tick pipeline and [module composition](./02-spec-controller-architecture.md#5-module-composition-rules),
the [seeded HAL](./03-spec-controller-hal-simulation.md#7-determinism--seeding), [sensing](./04-spec-controller-sensing.md),
and the [safety interlocks](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks).
*Targets* are deferred to the [NFR doc](../../artifacts/non-functional-requirements.md); the *tooling
and feedback loops* to [`spec-verification.md`](../spec-verification.md). (Concrete test framework and
fixtures are deferred to implementation, per the scope note in [the overview](./01-spec-controller-overview.md#5-conventions-used-across-the-set).)

---

1. **Per-stage unit suites.** Each pipeline stage — fusion, setpoint resolution, the control-loop
   hierarchy, the interlocks, the actuator constraints — is a **separately testable module behind an
   explicit interface** ([`P1-MAINT-1`](../../artifacts/non-functional-requirements.md);
   [architecture §5](./02-spec-controller-architecture.md#5-module-composition-rules)), unit-tested in
   isolation against hand-built inputs. The control-loop and safety-interlock modules carry
   **≥ 90% line coverage** ([`P1-TEST-1`](../../artifacts/non-functional-requirements.md)), measured
   with `cargo llvm-cov` ([tooling matrix](../spec-verification.md#4-tooling-matrix)) — the
   load-bearing modules where untested logic is least acceptable (CLAUDE.md "avoid untested logic").

2. **Golden control/safety scenario library, run through the seeded HAL.** The HAL is a
   **deterministic forward model under a fixed seed**
   ([`P1-TEST-2`](../../artifacts/non-functional-requirements.md);
   [HAL §7](./03-spec-controller-hal-simulation.md#7-determinism--seeding)) — the controller analog of
   the optimizer's deterministic twin, which makes a control scenario a **reproducible assertion**.
   Scenarios deliberately reach past the happy path; each fixes seed, config, and setpoints, then
   asserts the driven variable moves the intended direction **and** every fault/interlock assertion
   lands within its latency bound. Fault and interlock scenarios are driven by **explicit, seeded
   HAL injection** — [sensor-reading injection](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection)
   for the input side, [actuator fault injection](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection)
   for the output side — so the condition appears deterministically at a known tick rather than by
   tuning a disturbance toward it:

   - **Diurnal ramp** — the temperature PID tracks the day/night setpoint schedule and VPD stays near target.
   - **Redundant-temperature fault** — one probe stuck/outlier: TMR median voting holds with **no degradation** ([`P1-REL-2`](../../artifacts/non-functional-requirements.md), [sensing §2](./04-spec-controller-sensing.md#2-redundant-temperature-fusion-tmr)); on **total disagreement** the controller holds a safe state with **zero unhandled-fault crashes** ([`P1-RESIL-1`](../../artifacts/non-functional-requirements.md)).
   - **Non-temperature sensor fault** — an injected out-of-range / stuck reading is detected within the configurable window ([`P1-REL-3`](../../artifacts/non-functional-requirements.md)).
   - **Actuator health** — stuck / no-response detected within the window and the actuator/zone failed safe ([`P1-REL-4`](../../artifacts/non-functional-requirements.md), [safety §5](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)).
   - **Critical-temperature interlock** — injecting the temperature probes past the critical max asserts the interlock **within one tick** of detection ([`P1-REL-1`](../../artifacts/non-functional-requirements.md)), with the re-arm hysteresis governing **clearing only**.
   - **CO₂ vent interlock** — the injector is hard-off whenever vents exceed the interlock threshold (no enrichment while venting).
   - **Manual override auto-expiry** — a forgotten override releases after its timeout ([`P1-RESIL-2`](../../artifacts/non-functional-requirements.md)).

3. **Real-time & determinism properties.** The fixed-tick pipeline **runs to completion each tick**;
   tick rate, jitter, and per-tick compute budget (`P1-PERF-1/2/3`) are characterized under test, and
   REST writes are **latched to tick boundaries** with no mid-tick mutation
   ([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)).
   Determinism is itself an assertion: identical seed + inputs yield an **identical actuator
   trajectory**, which is what makes every scenario above stable.

4. **Contract conformance.** The frames the controller publishes (sensor readings, actuator state,
   fault events, the retained system-state snapshot) and its REST request/response surface validate
   against [`contracts/`](../../../../contracts/) — the **same schemas the harness checks**
   ([`spec-verification.md §5`](../spec-verification.md#5-the-contract-validation-harness),
   [interfaces](./08-spec-controller-interfaces.md)). A **slow / disconnected-broker** scenario
   asserts telemetry publishing **never blocks the control tick** and that the retained `gh/{id}/state`
   snapshot re-primes subscribers on reconnect ([`P1-RESIL-3`](../../artifacts/non-functional-requirements.md)).

An end-to-end integration test exercises the full path **behind the HAL trait** — seed → sense → fuse
→ resolve → control → interlock → constrain → drive + publish — asserting the published system-state
snapshot agrees with the commanded actuator state and that an
[injected fault](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection) surfaces in the
REST `/health` response within one tick ([`P1-OBS-2`](../../artifacts/non-functional-requirements.md)).
