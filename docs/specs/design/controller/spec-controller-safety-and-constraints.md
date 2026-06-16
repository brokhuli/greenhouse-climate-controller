# Controller — Safety Interlocks & Actuator Constraints

> **Purpose:** Define the controller's two guardrail layers and the priority model
> that binds them: **safety interlocks** (stage ⑤) that unconditionally protect the
> crop, and **actuator constraints** (stage ⑥) that shape every output to what real
> hardware can do. Together they are the back half of the
> [tick pipeline](./spec-controller-architecture.md#2-the-tick-pipeline) — they act
> on whatever the [control loops](./spec-controller-control-loops.md) and
> [manual override](./spec-controller-architecture.md#6-manual-override) produced.
> This file also owns **actuator health monitoring** ([§5](#5-actuator-health-monitoring)) —
> the output-side counterpart to sensor fault detection, which fails an actuator safe
> when its commands stop taking effect. Numeric limits (slew rates, min on/off times,
> critical thresholds, actuator-health windows) are consolidated in the
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

The irrigation row is the zone-scoped instance of a general rule: an actuator whose
command produces no effect is failed safe. That generalization — covering **every**
actuator, plus stuck and saturated actuators — is
[actuator health monitoring (§5)](#5-actuator-health-monitoring); the irrigation
interlock above is the special case that predates it.

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

## 5. Actuator health monitoring

Sensing has a full fault ladder for the *inputs*
([sensing](./spec-controller-sensing.md)); this section is its counterpart for the
*outputs*. A loop that commands a dead, jammed, or undersized actuator will keep
pushing harder against a plant that never responds — so the controller watches whether
its commands actually take effect and fails the actuator safe when they don't. The
monitor runs **every tick** from three inputs: the previous tick's **commanded**
outputs, this tick's **observed** actuator state read back from the
[HAL](./spec-controller-hal-simulation.md#1-the-hal-boundary), and this tick's
[trusted readings](./spec-controller-sensing.md). It is the actuator analogue of
[sensor fault detection](./spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)
(`P1-REL-4`).

Three distinct conditions, each with its **own** response — the response is the design,
not the detection:

| Condition | Detected by | Response |
|---|---|---|
| **Stuck** — actuator won't follow its command | `observed` diverges from `commanded` beyond a tolerance, for a configurable window | Disable the actuator (fail-safe per [§2](#2-safety-interlocks) bias); raise **alarm** |
| **No-response** — actuator obeys but has no effect | `observed` matches `commanded`, yet the variable it drives shows no change over a window after a commanded change | Disable the actuator / zone; raise **alarm** |
| **Saturation** — actuator works but can't keep up | output pinned at its min/max limit while loop error persists beyond a window | **Keep controlling** at the saturated output; raise **alarm** — do *not* disable |

The split between **no-response** and **saturation** is the load-bearing distinction.
Both look like "persistent error," but the safe action is opposite: a no-response heater
should be cut out (it is doing nothing useful and the fault must surface), whereas a
*saturated* heater is the crop's only heat source and must keep running — disabling it
would be the harmful action. So saturation never disables; it alarms and rides the limit
while [anti-windup](./spec-controller-control-loops.md#fast-loops--reactive) keeps the
integral from accumulating an unrecoverable correction. Saturation detection and the
`setpoint_unreachable` condition are owned by the loops
([control-loops — saturation](./spec-controller-control-loops.md#saturation--setpoint-unreachable));
this section owns only its safety response (alarm, never disable).

- **Stuck / no-response need a feedback channel.** Detection compares commanded against
  *observed* actuator state — a separate readback the
  [HAL exposes](./spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection)
  and that can diverge from the command. In the fault-free case observed equals commanded.
  The effect half (no-response) additionally needs a sensed variable to move; an actuator
  whose effect is currently **masked** (a shade screen commanded at night, a heater already
  at setpoint) can't be effect-verified that tick — the monitor only fires when a commanded
  change *should* produce a measurable response and none arrives.
- **Recovery is automatic.** Like sensor faults, actuator-health flags are **sticky** and
  clear when the actuator tracks its command again (or the masked effect reappears); the
  affected loop then resumes ([architecture §7](./spec-controller-architecture.md#7-failure-modes--degradation)).
- **Surfaced, never silent.** Each condition publishes an MQTT
  [fault event](./spec-controller-interfaces.md#2-mqtt--telemetry-out)
  (`actuator_stuck`, `actuator_no_response`, `setpoint_unreachable`) and is reflected in the
  REST [`/health`](./spec-controller-interfaces.md#5-published-shapes--health) surface
  (`P1-OBS-1`, `P1-OBS-2`).

Detection windows, the commanded-vs-observed tolerance, and the saturation duration are
consolidated in the
[default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference).

---

## 6. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The desired outputs being guarded | guards | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md) |
| Where override sits relative to safety | ordered by | [`spec-controller-architecture.md`](./spec-controller-architecture.md#6-manual-override) |
| Temperature-unavailable handoff from sensing | receives | [`spec-controller-sensing.md`](./spec-controller-sensing.md#5-the-degradation-ladder) |
| Observed actuator state + injected actuator faults | reads from | [`spec-controller-hal-simulation.md`](./spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection) |
| Saturation / `setpoint_unreachable` detection | shares with | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md#saturation--setpoint-unreachable) |
| Critical thresholds, slew rates, min on/off, actuator-health windows | consolidated in | [`spec-controller-config-and-parameters.md`](./spec-controller-config-and-parameters.md#default-parameters-reference) |
| Interlocks + actuator-health faults surfaced as faults/alarms | published via | [`spec-controller-interfaces.md`](./spec-controller-interfaces.md) |
| `P1-REL-1` (interlock latency), `P1-REL-4` (actuator-health detection) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
