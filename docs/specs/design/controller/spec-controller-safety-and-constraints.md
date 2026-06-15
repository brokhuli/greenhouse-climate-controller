# Controller — Safety Interlocks & Actuator Constraints

> **Purpose:** Define the controller's two guardrail layers and the priority model
> that binds them: **safety interlocks** (stage ⑤) that unconditionally protect the
> crop, and **actuator constraints** (stage ⑥) that shape every output to what real
> hardware can do. Together they are the back half of the
> [tick pipeline](./spec-controller-architecture.md#2-the-tick-pipeline) — they act
> on whatever the [control loops](./spec-controller-control-loops.md) and
> [manual override](./spec-controller-architecture.md#6-manual-override) produced.
> Numeric limits (slew rates, min on/off times, critical thresholds) are
> consolidated in the
> [default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference).

---

## 1. The guardrail model

The loops decide; the guardrails make those decisions *safe* and *physically
realizable*. They are deliberately separated from the loops because their job is
different: a loop optimizes toward a setpoint, a guardrail refuses to let any
decision — loop or operator — harm the crop or the (simulated) hardware. Guardrails
are always active and need no tuning to be correct; their thresholds only set *when*
they fire.

---

## 2. Safety interlocks

Always active. They take **unconditional priority** over all control loops **and**
over [manual override](./spec-controller-architecture.md#6-manual-override) — an
operator cannot suppress a safety response. A detected condition is acted on
**within one tick** (`P1-REL-1`); because fault detection and interlocks both run
every tick, this latency bound is structural, not best-effort.

| Condition | Response |
|---|---|
| Temperature > critical max | Override all loops; run all cooling at full; raise alarm |
| Temperature probes in total disagreement (no two agree) | Treat temperature as unavailable; hold safe state; raise alarm |
| CO₂ > safety ceiling | Open vents; disable injector; raise alarm |
| Irrigation fault (no moisture change after valve opens) | Disable zone; raise alarm |

These are crop/hardware-protection interlocks, distinct from the loop-level
[CO₂/vent interlock](./spec-controller-control-loops.md#fast-loops--reactive)
(a control optimization). The temperature-unavailable row is the bottom rung of the
[sensing degradation ladder](./spec-controller-sensing.md#5-the-degradation-ladder):
when fusion can no longer trust temperature, safety — not a loop — holds the state.

---

## 3. Priority & ordering model

The pipeline's back-half ordering **is** the safety guarantee. Each stage can only
*tighten* toward safety, never loosen:

```
③ control loops      propose desired outputs
        │
④ manual override    may REPLACE a loop's output (operator intent)
        │
⑤ safety interlocks  may OVERRIDE anything above (unconditional, crop protection)
        │
⑥ actuator constraints  SHAPE the surviving command to hardware limits
        ▼
   commanded output → HAL
```

Two consequences fall out of this order:

- **Override cannot defeat safety.** Because override is upstream of interlocks, a
  forced actuator value is still overridden by a critical-temperature or
  CO₂-ceiling response ([architecture §6](./spec-controller-architecture.md#6-manual-override)).
- **Even a safety response respects the hardware.** Because constraints are the last
  stage, an interlock that says "open vents fully" is still shaped by the vent slew
  rate ([§4](#4-actuator-constraints)) — vents open at maximum slew, not
  instantaneously. Safety chooses the *target*; constraints govern the *approach*.

---

## 4. Actuator constraints

A constraint layer sits between the resolved output and the HAL, enforcing limits
that reflect real hardware behavior. All limits are TOML-configurable.

| Actuator | Constraint |
|---|---|
| Roof vents / shade screen | Maximum slew rate (%/s) — motors cannot move instantly |
| Heater / CO₂ injector | Minimum on-time and off-time — anti short-cycle protection |
| Fans | Speed ramp-rate limit — gradual speed changes |
| Irrigation valves | Minimum open time — ensures meaningful water delivery |

These are applied **after** interlocks resolve the desired output ([§3](#3-priority--ordering-model)),
so the constraints shape the final command regardless of who produced it (loop,
override, or interlock). They model the plant's hardware reality so the control
problem the loops face is realistic — an instantly-repositioning vent would make
tuning meaningless.

---

## 5. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The desired outputs being guarded | guards | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md) |
| Where override sits relative to safety | ordered by | [`spec-controller-architecture.md`](./spec-controller-architecture.md#6-manual-override) |
| Temperature-unavailable handoff from sensing | receives | [`spec-controller-sensing.md`](./spec-controller-sensing.md#5-the-degradation-ladder) |
| Critical thresholds, slew rates, min on/off | consolidated in | [`spec-controller-config-and-parameters.md`](./spec-controller-config-and-parameters.md#default-parameters-reference) |
| Interlocks surfaced as faults/alarms | published via | [`spec-controller-interfaces.md`](./spec-controller-interfaces.md) |
| `P1-REL-1` (interlock latency within one tick) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
