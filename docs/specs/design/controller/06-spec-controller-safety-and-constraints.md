# Controller — Safety Interlocks & Actuator Constraints

> **Purpose:** Define the controller's two guardrail layers and the priority model
> that binds them: **safety interlocks** (stage ⑤) that unconditionally protect the
> crop, and **actuator constraints** (stage ⑥) that shape every output to what real
> hardware can do. Together they are the back half of the
> [tick pipeline](./02-spec-controller-architecture.md#2-the-tick-pipeline) — they act
> on whatever the [control loops](./05-spec-controller-control-loops.md) and
> [manual override](./02-spec-controller-architecture.md#6-manual-override) produced.
> This file also owns **actuator health monitoring** ([§5](#5-actuator-health-monitoring)) —
> the output-side counterpart to sensor fault detection, which fails an actuator safe
> when its commands stop taking effect. Numeric limits (slew rates, min on/off times,
> critical thresholds, actuator-health windows) are consolidated in the
> [default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

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
over [manual override](./02-spec-controller-architecture.md#6-manual-override) — an
operator cannot suppress a safety response. A detected condition is acted on
**within one tick** (`P1-REL-1`); because fault detection and interlocks both run
every tick, this latency bound is structural, not best-effort.

> **The one-tick bound is in *ticks*, not wall-clock milliseconds.** It holds at any
> [time-scale](./03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism):
> the interlock still fires the tick its threshold is crossed, so the *simulated*-time latency is
> unchanged, while the *wall-clock* latency simply tracks the cadence (a tick is 250 ms at 4×,
> 2000 ms at 0.5×). The actuator-health detection windows ([§5](#5-actuator-health-monitoring)) and
> the interlock dwell (`interlock_min_hold`) are likewise counted in ticks, so they too scale with
> the knob rather than drifting against simulated time.

| Condition | Response |
|---|---|
| Temperature > critical max | Override all loops; run all cooling at full; raise alarm |
| Temperature probes in total disagreement (no two agree) | Treat temperature as unavailable; hold safe state; raise alarm |
| CO₂ > safety ceiling | Open vents; disable injector; raise alarm |
| Irrigation fault (no moisture change after valve opens) | Disable zone; raise alarm |

These are crop/hardware-protection interlocks, distinct from the loop-level
[CO₂/vent interlock](./05-spec-controller-control-loops.md#fast-loops--reactive)
(a control optimization). The temperature-unavailable row is the bottom rung of the
[sensing degradation ladder](./04-spec-controller-sensing.md#5-the-degradation-ladder):
when fusion can no longer trust temperature, safety — not a loop — holds the state.

The irrigation row is the zone-scoped instance of a general rule: an actuator whose
command produces no effect is failed safe. That generalization — stuck, no-response,
and saturated actuators — is
[actuator health monitoring (§5)](#5-actuator-health-monitoring); the irrigation
interlock above is the special case that predates it. Its two detection halves have
different reach: **stuck** detection (commanded-vs-observed) covers **every** actuator,
while effect-based **no-response** detection covers only those with an unambiguous,
single-direction, unmasked effect — the house *push* actuators (heater, misters,
CO₂ injector, grow lights) and irrigation valves. A **bidirectional** actuator (fans,
roof vents) has coupled, sign-ambiguous effects, and a routinely-**masked** one (the
shade screen, idle whenever there is no sun to block) has no reliably observable effect
on a given tick; inferring "no effect" for either would risk a dangerous false fail-safe,
so their command-following is guarded by stuck detection alone.

### Assert and clear (re-arm hysteresis)

An interlock's **assert** and **clear** edges are deliberately asymmetric, so a reading
hovering at the threshold cannot chatter the interlock — and the safe response — on and
off every tick:

- **Assert is immediate.** An interlock fires the tick its threshold is crossed
  ([§3](#3-priority--ordering-model), `P1-REL-1`). Nothing about this changes; the
  one-tick latency guarantee is untouched.
- **Clear is hysteretic.** An asserted interlock de-asserts only after the reading
  returns past a configurable **`interlock_rearm_hysteresis`** margin (below the
  critical threshold, not merely back to it) **and** a configurable
  **`interlock_min_hold`** dwell has elapsed since it fired. This is the same
  deadband-against-cycling idea the
  [humidity hysteresis band](./05-spec-controller-control-loops.md#fast-loops--reactive)
  uses for normal control, applied here to the safety edge.

A single *physically impossible* spike never reaches the interlock — it is rejected
upstream as [out-of-range](./04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)
by sensor fault detection. A spike that is *in range* but spurious still asserts (a
deliberate bias toward safety: better an unnecessary cool-down than a missed
over-temp), and the hysteretic clear then prevents it from oscillating. This is why a
single-sensor interlock such as the CO₂ ceiling is acceptable without the redundant
fusion that temperature gets. Both thresholds are consolidated in the
[default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

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
  CO₂-ceiling response ([architecture §6](./02-spec-controller-architecture.md#6-manual-override)).
- **Even a safety response respects the hardware — but is never *delayed* by it.**
  Because constraints are the last stage, an interlock that says "open vents fully" is
  still shaped by the vent slew rate ([§4](#4-actuator-constraints)) — vents open at
  maximum slew, not instantaneously. Safety chooses the *target*; constraints govern
  the *approach rate*. The distinction is load-bearing: a constraint may shape **how
  fast** a safety transition moves (slew/ramp) but may **never block or delay** a move
  *toward* a safe state. In particular the **min on-time / off-time dwell
  constraints are waived** for such a transition — a heater
  de-energizes the tick a critical-temperature interlock fires even if its min-on
  window has not elapsed, because honoring an anti-short-cycle timer over a
  crop-protection interlock would defeat the `P1-REL-1` one-tick guarantee. The same waiver
  applies to a move toward safe driven by an **actuator-health disable** ([§5](#5-actuator-health-monitoring))
  or by a **control loop failing an actuator closed** because its governing sensor became untrusted
  (the CO₂ injector and irrigation valve fail closed — [sensing §4](./04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)):
  dwell must not hold a blind injector or valve on past the fault, or "never enrich/water blind"
  would be violated for the length of the dwell.

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

One carve-out for safety: the **min on-time / off-time** and **valve minimum open
time** rows are anti-short-cycle protections for *normal control* — they must not act
as a brake on a safety transition. A rate limit (slew, ramp) still applies to a
safety-commanded move because it reflects a physical maximum; a *dwell* constraint
(min on/off) is **waived** when the move is toward a safe state — whether forced by an
interlock ([§3](#3-priority--ordering-model)), by an
[actuator-health disable](#5-actuator-health-monitoring), or by a control loop failing an
actuator closed on sensor loss (the CO₂ injector and irrigation valve fail closed —
[sensing §4](./04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)).
Constraints may govern the approach rate of a safety response but never *block or delay* it.

---

## 5. Actuator health monitoring

Sensing has a full fault ladder for the *inputs*
([sensing](./04-spec-controller-sensing.md)); this section is its counterpart for the
*outputs*. A loop that commands a dead, jammed, or undersized actuator will keep
pushing harder against a plant that never responds — so the controller watches whether
its commands actually take effect and fails the actuator safe when they don't. The
monitor runs **every tick** from three inputs: the previous tick's **commanded**
outputs, this tick's **observed** actuator state read back from the
[HAL](./03-spec-controller-hal-simulation.md#1-the-hal-boundary), and this tick's
[trusted readings](./04-spec-controller-sensing.md). It is the actuator analogue of
[sensor fault detection](./04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)
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
while [anti-windup](./05-spec-controller-control-loops.md#fast-loops--reactive) keeps the
integral from accumulating an unrecoverable correction. Saturation detection and the
`setpoint_unreachable` condition are owned by the loops
([control-loops — saturation](./05-spec-controller-control-loops.md#saturation--setpoint-unreachable));
this section owns only its safety response (alarm, never disable).

- **Stuck / no-response need a feedback channel.** Detection compares commanded against
  *observed* actuator state — a separate readback the
  [HAL exposes](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection)
  and that can diverge from the command. In the fault-free case observed equals commanded.
  The effect half (no-response) additionally needs a sensed variable to move; an actuator
  whose effect is currently **masked** (a shade screen commanded at night, a heater already
  at setpoint) can't be effect-verified that tick — the monitor only fires when a commanded
  change *should* produce a measurable response and none arrives. For the same reason,
  no-response is evaluated only for actuators with a single-direction, unmaskable-enough
  effect — the push actuators and irrigation valves; the bidirectional actuators (fans, roof
  vents) and the routinely-masked shade screen are covered by stuck detection alone
  ([§2](#2-safety-interlocks)).
- **Recovery is automatic.** Like sensor faults, actuator-health flags are **sticky** and
  clear when the actuator tracks its command again (or the masked effect reappears); the
  affected loop then resumes ([architecture §7](./02-spec-controller-architecture.md#7-failure-modes--degradation)).
- **Surfaced, never silent.** Each condition publishes an MQTT
  [fault event](./08-spec-controller-interfaces.md#2-mqtt--telemetry-out)
  (`actuator_stuck`, `actuator_no_response`, `setpoint_unreachable`) and is reflected in the
  REST [`/health`](./08-spec-controller-interfaces.md#5-published-shapes--health) surface
  (`P1-OBS-1`, `P1-OBS-2`).

Detection windows, the commanded-vs-observed tolerance, and the saturation duration are
consolidated in the
[default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

---

## 6. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The desired outputs being guarded | guards | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) |
| Where override sits relative to safety | ordered by | [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md#6-manual-override) |
| Temperature-unavailable handoff from sensing | receives | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md#5-the-degradation-ladder) |
| Observed actuator state + injected actuator faults | reads from | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection) |
| Saturation / `setpoint_unreachable` detection | shares with | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md#saturation--setpoint-unreachable) |
| Critical thresholds, slew rates, min on/off, actuator-health windows | consolidated in | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md#default-parameters-reference) |
| Interlocks + actuator-health faults surfaced as faults/alarms | published via | [`08-spec-controller-interfaces.md`](./08-spec-controller-interfaces.md) |
| `P1-REL-1` (interlock latency), `P1-REL-4` (actuator-health detection) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
