# Controller — Sensing, Fusion & Fault Detection

> **Purpose:** Define how raw HAL readings become the **trusted state** the
> [control loops](./05-spec-controller-control-loops.md) consume — redundant
> temperature fusion with voting, the derived VPD quantity, per-sensor fault
> detection, the degradation ladder, and how faults are surfaced. This is **stage
> ①** of the [tick pipeline](./02-spec-controller-architecture.md#2-the-tick-pipeline):
> everything downstream sees only what this stage trusts. The physical sensor
> inventory is owned by
> [`physical-system-single.md`](../physical-system-single.md#inputs--sensors); this
> file owns the *conditioning*.

---

## 1. Why conditioning comes first

A control loop acting on a bad reading is more dangerous than a loop with no
reading — it confidently drives the wrong way. So no loop ever touches a raw HAL
value: stage ① combines redundant probes, validates every sensor, derives VPD, and
emits trusted values plus fault flags. Two distinct mechanisms operate here, and
they are **not** the same thing:

- **Competitive (redundant) fusion** — multiple sensors of the *same* quantity
  combined for fault tolerance. Phase 1 applies this only to temperature
  ([§2](#2-redundant-temperature-fusion-tmr)).
- **Single-sensor fault detection** — plausibility/liveness checks on every other
  sensor ([§4](#4-fault-detection-non-temperature-sensors)).

Advanced cross-quantity estimation (Kalman/complementary) is explicitly **not** here
— it needs the physics model and is
[deferred to Phase 3](./10-spec-controller-constraints.md#9-scope--deferred-controller-capabilities).

---

## 2. Redundant temperature fusion (TMR)

Temperature is measured by **three co-located probes** rather than one, and a
voting/fusion step combines them into a single trusted value before the temperature
PID and the VPD calculation consume it. Temperature gets this treatment because it
drives the most actuators — a bad temperature reading is the most dangerous single
sensor fault.

- **Median voting.** The fused value is the **median** of the readings, which
  rejects a single outlier (a probe reading wildly high or low) with no tuning.
  It is computed as a median over the readings slice, so the probe count is not
  hardcoded; **3 is the default — Triple Modular Redundancy**, the minimum that
  delivers single-fault *correction*, not just detection (`P1-REL-2`).
- **Disagreement detection.** If a probe deviates from the median by more than a
  configurable threshold, it is flagged faulty and excluded; control continues on
  the remaining probes — degraded but operational.
- **Loss of redundancy.** With only one trustworthy probe left, raise a
  loss-of-redundancy alarm (no further fault tolerance) but keep controlling
  (`P1-RESIL-1`).
- **Total disagreement.** If no two probes agree, treat temperature as
  **unavailable** and hand off to the
  [safety interlock](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks)
  rather than act on an untrusted value.

This is single-location, fault-tolerant sensing — distinct from sensing a spatial
gradient across the greenhouse, which is
[out of scope](../physical-system-single.md#out-of-scope-for-this-physical-model).

---

## 3. Derived sensing — VPD

**Vapor Pressure Deficit** (kPa) is not a sensor but a deterministic quantity
computed from fused temperature + relative humidity. It is the climate variable
that most directly reflects the moisture stress a plant experiences, which is why
the humidity and temperature loops
[jointly serve a VPD target](./05-spec-controller-control-loops.md#fast-loops--reactive)
rather than chasing RH alone. The physiology (why too-high and too-low both hurt) is
owned by
[`physical-system-single.md`](../physical-system-single.md#derived-value-vpd).

Because VPD is derived from fused temperature, it inherits temperature's trust
state: if temperature is unavailable ([§2](#2-redundant-temperature-fusion-tmr)) or
humidity has faulted ([§4](#4-fault-detection-non-temperature-sensors)), VPD is not
computed and the VPD loop is suspended.

---

## 4. Fault detection (non-temperature sensors)

Temperature fault handling is the fusion step above. **Every other sensor** runs
two detectors each tick (`P1-REL-3`, within a configurable detection window):

- **Stuck value** — reading unchanged beyond a configurable duration (sensor
  frozen).
- **Out-of-range** — reading outside physical plausibility bounds.

On fault, the controller applies a **fail-safe** response — biased toward the action
least likely to harm the crop — flags the sensor, logs it, publishes a fault event
over MQTT, and reflects it in the REST `/health` surface
([§6](#6-fault-surfacing)).

| Sensor | Out-of-range bound | Fail-safe response |
|---|---|---|
| Humidity | 0–100 % RH | Disable misters; suspend the VPD loop; alarm |
| CO₂ | ~200–5000 ppm | Disable injector (fail-closed — never enrich blind); alarm |
| PAR | sensor range | Fall back to time-based lighting schedule; alarm |
| Soil moisture (per zone) | 0–1 VWC | Disable that zone's irrigation (fail-closed — never water blind); alarm |

The numeric bounds and the stuck-window default are consolidated in the
[default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

---

## 5. The degradation ladder

Sensing failures move the controller down a ladder, never off a cliff — it keeps
running its tick at every rung:

```
full trust ──▶ degraded (probe/sensor excluded, fail-safe applied, alarm)
            ──▶ quantity unavailable (e.g. temperature: no two probes agree)
            ──▶ safety interlock holds a safe state
```

The rungs are owned across specs: exclusion/fail-safe here, the unavailable→safe
transition by [safety](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks),
and the per-stage view in
[architecture §7](./02-spec-controller-architecture.md#7-failure-modes--degradation).
Recovery is automatic: when a reading returns to plausibility (or probes re-agree),
the fault flag clears and the affected loop resumes.

This ladder is for the controller's *inputs*. Its *outputs* have a sibling ladder —
[actuator health monitoring](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring),
owned by safety — that fails an actuator safe when its commands stop taking effect, with the
same sticky-flag / automatic-recovery behavior.

---

## 6. Fault surfacing

Every fault detected here is observable through **both** outward surfaces, so a fault
is never silent (`P1-OBS-1`, `P1-OBS-2`):

- **MQTT** — a fault event is published, and the consolidated system-state snapshot
  carries current sensor health.
- **REST `/health`** — reflects every active fault and alarm
  ([interfaces](./08-spec-controller-interfaces.md)).

Wire formats for both are owned by [`contracts/`](../../../../contracts/); this
file owns *what* is reported, not its schema.

---

## 7. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Raw readings + probe behavior | consumes | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) |
| What the loops do with trusted state | feeds | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) |
| Unavailable-quantity → safe-state handoff | hands to | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks) |
| Where stage ① sits in the tick | composed by | [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md#2-the-tick-pipeline) |
| Disagreement threshold, plausibility bounds, stuck window | consolidated in | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md#default-parameters-reference) |
| Physical sensor inventory + VPD physiology | mirrors | [`physical-system-single.md`](../physical-system-single.md#inputs--sensors) |
| `P1-REL-2`, `P1-REL-3`, `P1-RESIL-1`, `P1-OBS-2` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
