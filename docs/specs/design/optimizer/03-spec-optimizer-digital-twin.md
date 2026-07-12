# Optimizer — Digital Twin & Simulation

> **Purpose:** Define the optimizer's **forward model** of a single greenhouse's
> climate — what it predicts and the deterministic disturbances it anticipates — and
> the guards on the model's own **numerical behavior** and **parameter fidelity** that
> keep a diverged or de-calibrated twin from feeding the planner a confident-but-wrong
> future.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the trajectory this
model produces is what the [planner](./04-spec-optimizer-planning.md) optimizes
against.

---

## 1. The forward model

The simulation engine is a **forward model** of a single greenhouse's climate, built on NumPy/SciPy.
Given an observed state and a given setpoint trajectory, it predicts how temperature, humidity,
CO₂, **VPD**, and accumulated **DLI** evolve over a planning horizon — the physics the Phase 1
controller deliberately approximates with first-order lag and the platform does not model at all
([P1 constraints §9](../controller/10-spec-controller-constraints.md#9-scope--deferred-controller-capabilities)).

It models the **coupling** between climate variables and the **lag** between an actuator change and
its effect (see the coupling problem in
[`physical-system-single.md`](../physical-system-single.md)), so that a plan can be evaluated *before*
it is committed rather than discovered through controller error.

Crucially, the twin anticipates only **deterministic, clock-known** disturbances — the diurnal
solar/temperature curve and the day/night setpoint schedule. It pre-positions for *when the sun
predictably rises*, not for a variable forecast. Reacting to a real weather feed (a cold front, a
passing cloud) is **weather-reactive** control and belongs to Phase 4.

### 1.1 State vector

The twin integrates five state variables and derives two more:

| Field | Unit | Kind | Plausibility envelope |
|---|---|---|---|
| `temperature_c` | °C | integrated | [−50, 90] |
| `relative_humidity_pct` | %RH | integrated | [0, 100] |
| `co2_ppm` | ppm | integrated | [0, 20000] |
| `par_umol_m2_s` | µmol·m⁻²·s⁻¹ | integrated | [0, 5000] |
| `soil_moisture_vwc` (per zone) | VWC | integrated | [0, 1] |
| `vpd_kpa` | kPa | **derived** | — |
| `dli_mol_m2_day` | mol·m⁻²·day⁻¹ | **derived** | — |

VPD and DLI are **derived, never integrated** — VPD from `(temperature, humidity)` and DLI
by accumulating PAR (§1.2). The envelopes are the controller HAL's own clamps
([HAL §6](../controller/03-spec-controller-hal-simulation.md#6-bounded-fidelity)); a step
leaving them is a divergence ([§2](#numerical-stability)). Soil moisture is per irrigation
zone; every other variable is greenhouse-scoped.

### 1.2 Governing equations

The twin is the **coupled first-order-lag** model of the controller HAL
([HAL §2](../controller/03-spec-controller-hal-simulation.md#2-coupled-first-order-lag))
lifted into NumPy/SciPy — the same structure that produces the telemetry the twin is later
scored against ([§2](#parameter-fidelity--drift)), so mirroring it is what makes fidelity
meaningful. Each variable relaxes toward a **target** built from a disturbance/ambient term
plus the actuator coupling sum — the actuator-effect-set sum of the
[HAL §3 coupling matrix](../controller/03-spec-controller-hal-simulation.md#3-coupling-matrix):

```
x_target = ambient_x + Σ_actuators  gain(actuator, x) · level_actuator / 100
```

with gains, τ, and disturbances taken verbatim from the controller's committed defaults
([HAL config](../controller/07-spec-controller-config-and-parameters.md), values in
`climate-controller/config/greenhouse.example.toml`): heater +22 °C; fans (−10 °C /
−20 %RH / −200 ppm); roof vents (−12 °C / −30 %RH / −300 ppm); misters (+40 %RH / −3 °C);
CO₂ injector +1200 ppm; grow lights (+600 PAR / +2 °C); shade (−900 PAR / −4 °C);
τ = {temperature 120 s, humidity 60 s, CO₂ 30 s, PAR 10 s, soil 1800 s}.

**Integrator — analytic exponential, not Euler.** Because τ runs as low as 10 s while the
twin steps in minutes (`twin.solver_max_step_minutes`,
[configuration](./11-spec-optimizer-configuration.md), default 5), the controller's explicit
form `x += (Δt/τ)·(x_target − x)` would be unstable (`Δt/τ ≫ 1`). The twin advances each
variable with the **exact** first-order-lag solution instead — unconditionally stable at any
step, identical at the fixed point:

```
x(t+Δt) = x_target + (x(t) − x_target) · e^(−Δt/τ)
```

Three terms carry over from the
[HAL §5 disturbance model](../controller/03-spec-controller-hal-simulation.md#5-hidden-disturbance-model):
an explicit envelope-conduction pull on temperature toward outdoor (`heat_loss_coeff`),
daylight plant CO₂ uptake, and per-zone soil that fills toward saturation when the valve is
open and otherwise dries at a constant ET draw down to a residual floor — never toward zero.

**Derived each step.** VPD uses the Tetens/Magnus form the controller applies to both
observed VPD and its RH target, so twin and controller cannot drift apart
([sensing](../controller/04-spec-controller-sensing.md)):

```
svp(T) = 0.61078 · exp(17.27·T / (T + 237.3));   VPD = svp(T) · (1 − RH/100)
```

DLI accumulates PAR over the day, `DLI += PAR · Δt / 1e6` (µmol·m⁻²·s⁻¹ → mol·m⁻²), reset at
UTC-of-day midnight (§1.4).

**Mean-field.** Unlike the HAL the twin injects **no sensor noise** — it predicts the
expected trajectory, so the seeded per-channel noise is omitted.

**Step discretization.** Integration runs in fixed sub-steps of ≤ `solver_max_step_minutes`
under a **zero-order hold**: the reduced-controller actuator levels (§1.3) and the solar
fraction (§1.4) are sampled at each sub-step's start and held constant across it, so each
`x_target` is constant and the exponential update is exact. The per-sub-step order is fixed
for determinism: (1) resolve day/night setpoints and controller levels from the current
state, (2) advance every variable one sub-step, (3) advance the clock and accumulate DLI.
Actuator slew/ramp limits are dropped — at a multi-minute step they are already exhausted
(roof vents at 5 %/s reach full travel in ≪ one step).

### 1.3 Controller approximation (reduced)

The Phase 3 planner refines **setpoints, not actuator commands**, so the twin must roll the
baseline setpoints forward with the Phase 1 controller **in the loop**: at each sub-step it
derives the actuator levels the controller would command from the current state, then feeds
them into the coupling sum. v1 uses a **reduced** controller — it reproduces setpoint
tracking and the one interlock that changes cross-variable coupling, and defers the
controller's timing detail. The complete rule set (mirroring the
[control loops](../controller/05-spec-controller-control-loops.md)):

| Actuator(s) | Rule | Mirrors |
|---|---|---|
| heater | `e = T_set − T`; if `e > 0`: `level = clamp(Kp·e, 0, 100)` | Temperature PID |
| fans + roof vents | if `e < 0`: **both** `level = clamp(Kp·|e|, 0, 100)` (cooling vents, so its CO₂/RH coupling is captured) | Temperature PID |
| misters | bang-bang: on when `RH < RH_target`, where `RH_target` is the SVP inversion of `vpd_target_kpa`, clamped to `[humidity_low_pct, humidity_high_pct]` | Humidity hysteresis (VPD feedforward) |
| CO₂ injector | bang-bang: on when `CO₂ < co2_target_ppm`; **forced off when roof-vent level > `co2_vent_interlock_threshold_pct`** | CO₂ on/off + vent interlock |
| grow lights / shade | lights on when projected end-of-day DLI `< dli_target_mol` inside the day window; shade on when already `≥ target` | Lighting / DLI accumulation |
| irrigation valve (per zone) | open when the zone's `schedule` window is active **and** `soil < moisture_low_threshold`; close at `soil ≥ moisture_high_threshold`; honor the `drain_period_secs` gap | Irrigation scheduler |

`T_set` is the day/night target resolved by the schedule
([setpoint resolution](../controller/05-spec-controller-control-loops.md#setpoint-resolution)).
`Kp` is the one **tuned implementation default** in the model — fixed against the seeded twin
the way the HAL gains were, *not* the Phase 1 PID `kp`. What v1 **defers** is timing-detail
fidelity only: exact PID gains + anti-windup, hysteresis band widths, and short-cycle dwell
timers — none of which changes where the closed loop settles or how variables couple.

**Known gap — `expected_peak_par`.** The controller's lighting loop projects remaining
daylight from the operator's clear-sky estimate `expected_peak_par` to decide when grow-lights
and shade switch, but that field is **controller-only** — absent from the platform's setpoints
bundle and every optimizer contract ([§1.5](#15-parameter-source)) — so the twin projects from
its bundled solar `peak_par` default instead. When the two disagree the twin mis-times the
light/shade switch: a *controller-approximation* error the fidelity residual
([§2](#parameter-fidelity--drift)) surfaces but cannot correct. Exposing `expected_peak_par`
through Phase 2 (it is an operator input, not a fitted constant) would close this with no
calibration machinery; it is tracked as a deferred platform item
([scope](./13-spec-optimizer-scope.md)).

### 1.4 Deterministic disturbances

The twin anticipates only **clock-known** disturbances — never a weather feed (Phase 4).
Natural light is the raised half-sine of the HAL: over `[sunrise, sunset)`,
`solar = sin(π · (s − sunrise)/(sunset − sunrise))`, zero at night, scaling `peak_par` (the
PAR target) and `peak_heat_gain_c` (the temperature target). Outdoor temperature, ambient
humidity, and ambient CO₂ (420 ppm) are static; daylight adds plant CO₂ uptake, and the
day/night setpoint schedule switches `T_set`.

**Time-of-day convention.** The [planning context](#17-initialization-from-planning-context)
carries **no timezone** and stamps all telemetry in UTC against the greenhouse's simulated
clock, yet the day window, `sunrise`/`sunset`, irrigation `schedule`, and the DLI midnight
reset are all `HH:MM` "local time-of-day". v1 interprets **every `HH:MM` as UTC-of-day**,
matching the controller, which compares schedules against its UTC-seeded `second_of_day`. The
twin maps each horizon instant's UTC second-of-day directly — no timezone conversion.
Per-site localization is deferred with calibration ([scope](./13-spec-optimizer-scope.md)).

### 1.5 Parameter source

The twin is parameterized from **static bundled defaults**, seeded from the controller's
committed HAL parameters
([HAL config](../controller/07-spec-controller-config-and-parameters.md)): the
coupling-matrix gains, the τ constants, the disturbance constants, and the solar curve. These
ship with the optimizer service, not per greenhouse — Phase 2 profiles supply crop-safe
**bounds** on setpoints, not equipment thermal parameters, and the platform `Setpoints`
bundle carries no solar/daylight fields — notably the controller's `expected_peak_par` is not
exposed ([§1.3](#13-controller-approximation-reduced)) — so the solar model is entirely a
bundled default.
**Per-greenhouse calibration and auto-fitting are out of scope**
([scope](./13-spec-optimizer-scope.md)): v1 detects drift
([§2](#parameter-fidelity--drift)) but does not correct it.

### 1.6 Twin output (predicted trajectory)

The twin emits a **predicted-climate trajectory**: points spaced at
`twin.output_interval_minutes` ([configuration](./11-spec-optimizer-configuration.md),
default 60 — the planner's hourly granularity) across the horizon, each carrying the full
state + derived vector under the baseline setpoints, plus per-run flags (`diverged`,
`fidelity_attenuated`). Internally the sim steps at ≤ `solver_max_step_minutes`; only the
output points are down-sampled.

This is **not** the [`OptimizerPlan.trajectory`](./05-spec-optimizer-plan-contract.md#trajectorypoint).
The twin's series is a predicted *climate* future the [planner](./04-spec-optimizer-planning.md)
reads as context; `OptimizerPlan.trajectory` is the planner's proposed *setpoint* refinements.
Keeping the two distinct is what lets the planner reason about *where the baseline climate is
heading* separately from *what it wants to change* — and it is this **climate** forecast, retained
in memory from the last planner run as the **reference forecast**, that the next cycle's
[state-change gate](./04-spec-optimizer-planning.md#invocation-strategy) diffs against
(climate-vs-climate), never the setpoint trajectory.

### 1.7 Initialization (from planning context)

The sim is seeded from one
[planning-context read](../../../../contracts/optimizer-read-rest/components/schemas/planning-context.json),
anchored at the context `to` (the greenhouse's latest stored instant):

- **Integrated variables** seed from the **mean of the latest telemetry bucket** at `to`
  (per-zone soil from its own latest bucket). The twin assumes 1-hour buckets
  (`interval = "1h"`, the planner's granularity); the coarser `6h`/`1d` the contract also
  allows remain valid but blur the seed.
- **DLI** is not a telemetry metric, so it is rebuilt by integrating the PAR history from the
  day's `sunrise` to `to` (`Σ bucket_mean · seconds / 1e6`). If the window opens after
  sunrise the pre-window daylight is unrecoverable and DLI seeds from window start — a
  bounded under-count the residual ([§2](#parameter-fidelity--drift)) surfaces, not a silent
  error.
- **Actuator start levels** come from the actuator snapshots (`observed`, else `commanded`) —
  informational only, since §1.3 recomputes levels each sub-step.

A required-metric hole never reaches the twin — including a **missing or stale per-zone
`soil_moisture`** for a greenhouse that declares irrigation zones, which the
[input-quality gate](./07-spec-optimizer-input-gating.md) now requires just like a climate metric: the
gate has already failed the cycle upstream, so the twin always seeds every integrated variable
(per-zone soil included) from real telemetry rather than a fabricated default.

---

## 2. Robustness & fidelity

[The forward model](#1-the-forward-model) above describes what the twin computes, and
[input gating](./07-spec-optimizer-input-gating.md) gates its **inputs** — but nothing yet guards the
twin's own **numerical behavior** or whether its **parameters still match the real greenhouse**. A
forward model can diverge (stiff dynamics, a bad step) or silently de-calibrate (thermal mass,
leakage, or a failing vent seal change over weeks) — and either failure yields a confident trajectory
the planner then optimizes against. The output gates
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety),
[application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application))
cannot catch it, because the resulting *plan* looks perfectly valid; the error is upstream, in the
future the plan was built on.

### Numerical stability

The integrator runs with a bounded step (`twin.solver_max_step_minutes`,
[configuration](./11-spec-optimizer-configuration.md)) — taken with the analytic exponential
update ([§1.2](#12-governing-equations)), which stays stable even when that step ceiling far
exceeds the fastest τ — and checks every step for **non-finite** state (NaN / Inf) and states
outside the **physically plausible** envelopes ([§1.1](#11-state-vector): temperature past
sensor range, negative humidity or CO₂). The analytic update is closed-form and non-iterative, so there
is no convergence loop to fail — divergence surfaces as a non-finite or out-of-envelope step, never as
non-convergence. A diverged simulation is
treated exactly like a failed input precondition ([input gating](./07-spec-optimizer-input-gating.md)):
the optimizer does **not** hand a garbage trajectory to the planner — it **holds the last applied
bundle** (or the Phase 2 baseline if none exists,
[resilience — degrade fallback](./09-spec-optimizer-resilience.md)) and raises a `twin_diverged` escalation
([reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)), traced by `optimizer_run_id`
([P3-OBS-1](../../artifacts/non-functional-requirements.md)). The solver is fixed-step / seeded so a
scenario reproduces, making the twin the deterministic forward model
[evaluation](./08-spec-optimizer-evaluation.md) already relies on — the optimizer-side analog of the
controller's seeded HAL ([P1-TEST-2](../../artifacts/non-functional-requirements.md)).

### Parameter fidelity & drift

The twin runs on bundled default parameters ([§1.5](#15-parameter-source)) that only approximate each
greenhouse's true thermal mass, leakage, and actuator gains — constants that drift further seasonally and
as equipment ages. Each cycle the optimizer computes a **one-step-ahead residual**: the previous cycle's
predicted trajectory against the now-observed telemetry. A residual that stays beyond `twin.divergence_threshold`
([configuration](./11-spec-optimizer-configuration.md)) is a **fidelity fault** — the model no longer
matches the greenhouse. The response is **graded, not binary**: the twin keeps running (a degraded
prediction still beats none), but plan **confidence is attenuated** so a low-fidelity model's plans
fall below the
[application-gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)
threshold and **escalate rather than auto-apply** (`twin_fidelity_fault`,
[reason codes](./10-spec-optimizer-interfaces.md#escalation-reason-codes)), and persistent divergence is
surfaced for recalibration. Refitting the parameters from history is **deferred**
([scope](./13-spec-optimizer-scope.md)) — Phase 3 *detects and flags* drift; it does not auto-tune.

**Concretely.** Per required metric — `temperature`, `humidity`, `co2`, `par` (VPD and DLI are excluded,
being derived) — the residual is `r = |predicted − observed| / span`, normalized by the metric's
plausibility-envelope width ([§1.1](#11-state-vector)) so one dimensionless scale spans every metric and no
near-zero reading blows up the denominator. It is evaluated at the context `to`, comparing the **previous**
cycle's retained trajectory — linearly interpolated to `to`, since the hourly points rarely land on it —
against the latest bucket mean at `to`; if `to` lies past the retained trajectory's span, the check is
**skipped**, not extrapolated. The aggregate is `R = mean(r)` over the available metrics; `R >
twin.divergence_threshold` (default 0.15) sustained for `twin.fidelity_breach_cycles` (default 3)
consecutive cycles is the fidelity fault. Attenuation is a **hard cap**: on fault the plan's `confidence`
is capped just below `confidence_threshold`, guaranteeing the escalation, while the raw `R` is carried for
telemetry. The previous trajectory lives in memory only
([resilience](./09-spec-optimizer-resilience.md)); a cold-start cycle with no prior prediction skips the
check.

The crop-safe constraint engine
([constraint engine](./06-spec-optimizer-constraints-and-application.md#1-constraint-engine--safety))
and the controller's interlocks remain the hard backstop regardless of twin quality, so a drifted or
diverged twin **degrades optimization, never safety** — the same principle as everywhere else in this
spec: the deterministic gates, not the model, are what keep the greenhouse safe.
