# Architecture Design Record

A running log of significant architectural decisions and their rationale. Newest entries at the top.
Most entries correspond to an accepted RFC in [`request-for-comments.md`](./request-for-comments.md).
The foundational tech-stack entries (early June 2026) predate the RFC process and record stack
choices no RFC covers — language, framework, and supporting-service selections, with their
alternatives and tradeoffs.

---

## 2026-06-19 — Simulated-clock time-scale: a live, per-controller, simulation-only speed knob

**Decision:** Add a **time-scale (speed) knob** to the simulated controller so a simulation can be
run faster or slower than real-time at runtime — 0.5× / 1× / 2× / 4× and any value in a clamped range
— with the frontend visualizing and driving it live. The knob acts on the **scheduler only**, never
the simulation itself:

- **Two clocks; the knob touches one.** A **simulated clock** advances simulated time by a fixed step
  `Δt` (one second) **every tick** — the only time the pipeline reads. A separate **scheduler** sets
  the wall-clock cadence; `time_scale` changes it to `sleep = tick_period / time_scale`. `Δt` and the
  seeded PRNG draw order are **untouched**, so the tick-for-tick reading sequence is identical at any
  speed and `(seed, config, command-log)` replay stays bit-identical (`P1-TEST-2`). Scaling `Δt`
  instead was **rejected**: it would change the lag integration, risk instability as `Δt → τ` (30 s),
  and break replay.
- **Independent per-controller clocks; no shared master.** Each controller owns its clock and speed.
  A fleet-wide "set all" is a **convenience that fans out as N independent writes**, not a coordinated
  global clock — the distributed-time machinery (a master authority slaving N schedulers) was
  considered and **rejected** as needless coupling for a dev/sim feature.
- **Domain durations in ticks; infra timers on wall-clock.** Every in-simulation duration (drain,
  DLI day, override/injection expiry, saturation/no-response windows, `interlock_min_hold`) is counted
  in **ticks (simulated seconds)** so it scales with the knob automatically; genuinely wall-clock
  infrastructure timers (MQTT reconnect backoff, HTTP) stay on wall-clock and do not scale.
- **Envelope `ts` is the simulated instant.** The controller already stamps `ts` from its injected
  clock, so under acceleration `ts` is simulated time — consumers plot telemetry on simulated time
  directly with **no new timestamp field**.
- **Simulation-only, ephemeral, latched.** The knob is a sim-only HAL extension (like sensor
  injection); a real-hardware backend rejects it (404). It is **ephemeral** — resets to the configured
  default (1×) on restart, like an override — and latched to the next tick like every other write.
- **Live from the frontend via a platform relay — one explicit exception.** Unlike sensor injection
  (which the platform never calls), the platform **does** expose a thin sim-only relay
  (per-greenhouse and fleet-wide) so the dashboard's speed knob can drive it live. This is a
  deliberate, narrow exception to the platform's setpoint-only downward control — a diagnostic, not a
  setpoint.
- **Optimizer pauses off 1×.** The Phase 3 optimizer is wall-clock-paced; it **holds** (a transient
  input-gate reason) when a greenhouse reports `time_scale ≠ 1.0` and resumes at 1×. Coordinating
  optimizer cadence with arbitrary speeds is out of scope.

**Limitations (accepted):** speed-up is **CPU-bound** — at scale `S` the wall interval is `1000/S` ms
and must stay above the per-tick compute budget (`P1-PERF-3`, ≤100 ms), so the range is clamped to
0.25–8×; the wall-clock real-time targets (`P1-PERF-1/2`) describe the 1× baseline and relax off 1×
(on the simulated backend only); telemetry arrival becomes bursty at `S` Hz; per-controller clocks
mean cross-greenhouse wall-clock comparison is not meaningful.

**Scope:** specs + contract surface only. As with the surrounding contract-authoring entries, the
Phase 1 control runtime is not yet implemented, so there is no scheduler, `SimClock`, or REST handler
code to change here — the behavior is specified across the controller specs (architecture §3, HAL §7,
control-loops, safety §2, interfaces §3, constraints §1, config-and-parameters), the frontend/platform/
optimizer specs, and the NFR note; the runtime `SimClock` + scheduler + handler land in the controller
runtime slice.

**Contract changes (additive):** `contracts/controller-rest/` gains a simulation-only `GET`/`PUT
/sim/time-scale` with a `TimeScalePut` / `TimeScale` schema (mirroring the sensor-injection shapes),
under the existing `simulation` tag and `x-simulation-only`. `contracts/mqtt/system-state` gains an
optional `simulation` object (`time_scale`, `tick_index`), and the envelope `ts` description is
clarified as the controller's (possibly simulated) clock instant. `contracts/frontend-ws` adds an
optional `time_scale` to the `status` frame (+ a `common` `$def`); `contracts/frontend-rest` adds a
sim-only per-greenhouse `GET`/`PATCH /api/greenhouses/{id}/sim/time-scale` plus a fleet-wide `PATCH
/api/sim/time-scale` (returning a per-greenhouse `FleetTimeScaleResult`), and a nullable `time_scale`
on `GreenhouseSummary` / `GreenhouseDetail`. Fixtures are added and registered in each contract's
`cases.json`. All changes are **additive**, so every contract's major version stays at **1**.

**Why:** A speed knob makes the simulation a far better development and demonstration tool — slow-motion
to inspect a transient, fast-forward to reach a DLI/drain/photoperiod milestone — without sacrificing
the determinism the test strategy depends on. Realizing speed as *cadence* (not step size) is the whole
trick: it keeps `Δt`, the seed, and therefore replay untouched, so the feature costs nothing in
reproducibility. Keeping it simulation-only, ephemeral, and per-controller keeps it consistent with the
existing sim surfaces (sensor injection, manual override) and the independent-greenhouse model; the one
platform-relay exception is justified by the explicit requirement for a *live* frontend control.

**Basis:** Operator-directed capability addition. Determinism/real-time posture per
[controller constraints §1](../specs/design/controller/10-spec-controller-constraints.md#1-determinism--real-time)
and `P1-TEST-2`; REST-sole-write-path and unauthenticated-on-trusted-network postures per
[RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) /
[RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries);
contract-versioning discipline per
[RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 2026-06-19 — All values are in fixed SI/agronomic base units; no conversion layer

**Decision:** Every value in the system — sensor readings, setpoints, config parameters, contract
payloads, and database rows — is expressed in a single fixed set of base units with no conversion
layer at any boundary:

| Domain | Unit |
|---|---|
| Temperature | °C |
| Relative humidity | %RH |
| CO₂ | ppm |
| VPD | kPa |
| Soil moisture | %VWC |
| PAR / DLI | µmol·m⁻²·s⁻¹ / mol·m⁻²·d⁻¹ |
| Timing | ms / s (SI) |

No component accepts alternate units (e.g. °F) at its boundary and converts internally. If a display
layer ever needs a different unit, that is a pure presentation transform in the frontend — not
something the controller, platform API, optimizer, or any contract needs to handle.

**Why:** A single unit set eliminates an entire class of conversion bugs (off-by-factor errors, unit
mismatch across boundaries) and removes the need for unit metadata in every payload. The MQTT
contract already enforces this as a schema-level invariant — the `if/then` metric→unit binding
rejects a mismatched unit at the contract boundary
([RFC-007 §4](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
[2026-06-07 MQTT contract ADR](#2026-06-07--contract-conventions-topic-taxonomy-identity-payload-envelope-json-schema)).
Extending the same rule uniformly means no translation is needed anywhere in the stack — a value read
from a sensor, written to the DB, pushed over MQTT or REST, and consumed by the optimizer is the same
number in the same unit throughout.

**Basis:** Operator-directed design decision. No RFC.

---

## 2026-06-19 — Sensor reading injection: a simulation-only HAL surface for creating fault/interlock conditions on demand

**Decision:** Add **explicit sensor reading injection** to the controller — a way to force a
sensor channel to a specified value so a fault or interlock condition can be created **on
demand** rather than waited for (e.g. drive temperature past `critical_temperature_max` and
assert the interlock fires within one tick, without restarting to retune a disturbance
profile). It is the **input-side counterpart** to the actuator fault injection already specified
in [HAL §8](../specs/design/controller/03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection),
and it backs the verification spec's long-standing "an injected fault surfaces in `/health`
within one tick" assertion, which previously had no specified mechanism. Shape settled:

- **Applied below fusion, through the trait, never around it.** Injection sits in front of the
  coupled-lag output in the **simulated** backend: an overridden channel returns the injected
  value, every other channel falls through normally, and the value then flows through fusion →
  fault detection → loops → interlocks identically to a real reading. It is reached through a
  **simulation-only HAL extension** (a `SimControl`-style surface), not a reach past the trait
  into simulator internals — so a real-hardware backend neither implements nor exposes it and
  the HAL seam stays clean (`P1-MOD-1`,
  [HAL §9](../specs/design/controller/03-spec-controller-hal-simulation.md#9-sensor-reading-injection)).
- **Per channel, including per probe.** Injectable channels are the raw sensor outputs:
  temperature (each TMR probe), humidity, CO₂, PAR, and per-zone soil moisture. Injecting all
  three temperature probes drives the fused median (the path to the critical-temperature
  interlock); injecting one drives outlier/disagreement detection. The derived `vpd` is not a
  channel — reach it by injecting temperature + humidity.
- **Explicit, latched, auto-expiring.** Scope is **explicit injection only** — no PRNG-driven
  random sensor faults. An injection is set on demand, latched to a tick boundary like any REST
  write, and carries an auto-expiry (`sensor_injection_timeout_secs`, default 300 s) plus an
  explicit clear, so it cannot silently pin a variable (the analogue of `P1-RESIL-2`). Because
  it is explicit, it is part of the (seed, config, command-log) replay tuple, so an injection
  scenario replays tick for tick (`P1-TEST-2`).
- **REST, simulation-only, not a production path.** It is exposed over the existing REST surface
  (no new MQTT command path — telemetry stays out-only); in managed mode the platform does not
  call it. It is the only REST surface gated to the simulated backend.

**Scope:** specs + contract surface only. As with the surrounding contract-authoring entries,
Phase 1 control code is not yet implemented, so there is no HAL, REST, or pipeline code to
change here; the behavior is specified in the controller specs (HAL §9, interfaces §3, config-
and-parameters §, constraints §4–5, verification §) and the contract surface is authored.

**Contract changes (additive):** `contracts/controller-rest/` gains a simulation-only resource —
`GET /sim/sensor-injections` and `PUT`/`DELETE /sim/sensor-injections/{metric}` — with a new
`sim.json` component (`InjectableMetric`, `SensorInjectionPut`, `SensorInjection`) mirroring the
manual-override shapes, a `Metric` path parameter, a `simulation` tag, and `x-simulation-only`
on each operation. `InjectableMetric` is kept in sync with the measured subset of the MQTT
`sensor-reading` metric enum (minus the derived `vpd`). Three fixtures are added
(`sim-injection.put`, `sim-injection`, and the `sim-injection.bad-probe` counter-example) and
registered in `examples/cases.json`. A new endpoint is **additive** per
[`contracts/README.md`](../../contracts/README.md), so `info.version` stays at major **1** — no
side-by-side major is needed (and no consumer is deployed regardless).

**Why:** The controller had no way to create a fault condition live — the only lever was lowering
a threshold under the current reading, never pushing a reading up — yet the verification strategy
already assumed injected faults. Specifying injection as the deterministic driver makes the
critical-temperature-interlock and out-of-range sensor scenarios reproducible assertions instead
of disturbance-tuning, and gives a standalone operator a way to exercise the safety path by hand.
Routing it through a simulation-only trait extension keeps the change zero-cost above the HAL and
preserves the swappable-backend invariant; keeping it explicit (no random faults) keeps
determinism intact; latching + auto-expiry keep it consistent with manual override and the
no-stranding guarantee.

**Basis:** Operator-directed capability addition. REST-sole-write-path and unauthenticated-on-
trusted-network postures per
[RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) /
[RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries);
contract-versioning discipline per
[RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 2026-06-18 — VPD becomes the primary humidity control input (feedforward); humidity band demoted to safety clamp

**Decision:** Make `vpd_target_kpa` the **primary** input to humidity control. Each tick the
humidity loop derives its RH target by inverting vapor-pressure deficit at the fused air
temperature — `target_rh = 100 · (1 − vpd_target_kpa / svp(T))`, air-VPD convention consistent with
[sensing §3](../specs/design/controller/04-spec-controller-sensing.md#3-derived-sensing--vpd) — clamps it to
`[humidity_low_pct, humidity_high_pct]`, and runs hysteresis of width `humidity_deadband_pct`
around the clamped target. `humidity_low_pct` / `humidity_high_pct` are **demoted** from primary
fog-on/fog-off thresholds to **safety clamp bounds** (and the fallback band when the feedforward is
unavailable). A new `humidity_deadband_pct` setpoint replaces the implicit deadband the old band
width provided. The previously **decorative** `vpd_target_kpa` (stored and validated but consumed
by nothing) becomes load-bearing.

Two degradation paths are specified distinctly: a **humidity-sensor fault** removes RH feedback, so
the loop fails safe (misters off, alarm); a **temperature-unavailable** fault removes `svp(T)`, so
the target falls back to the midpoint of the safety bounds while RH feedback still drives the loop.
VPD *observation* (temp + RH) is unavailable in either case. The default safety bounds widen from
`[65, 75]` to `[50, 85]` %RH so a `vpd_target_kpa = 1.0` target (~57 %RH at 20 °C, ~76 %RH at 30 °C)
is not clamped flat across the normal day/night range.

**Scope:** this lands the **config surface and the design** only. Phase 1 is the config slice; there
is no control-loop, sensor-fusion, or VPD code yet ([`lib.rs`](../../climate-controller/src/lib.rs):
loops "land in later slices"). The behavior is specified in the controller specs (control loops §,
sensing §3–5, architecture §2/§4, config-and-parameters §) and the psychrometric inversion (`svp`,
`rh_from_vpd`) is **deferred** to the loop slice that will call it — added there alongside its
consumer as a single shared function so VPD observation and the control inversion cannot drift.

**Contract changes (breaking):** the controller-rest and frontend-rest `Setpoints` / `SetpointsPatch`
schemas gain a **required** `humidity_deadband_pct` (0–50 %RH) and reword `humidity_low_pct` /
`humidity_high_pct` (safety clamp bounds) and `vpd_target_kpa` (primary control input). Following the
[2026-06-16 precedent](#2026-06-16--actuator-health-monitoring-observed-actuator-channel-and-mqtt-connection-resilience-model),
because Phase 1 is not yet implemented and **no consumer is deployed**, the schemas are edited **in
place at major `info.version` 1** rather than retained side-by-side; once a controller or platform
consumes these, the same change would instead bump the major per
[`contracts/README.md`](../../contracts/README.md). Fixtures (including both `setpoints.bad-range`
counter-examples and the embedded bundles in `greenhouse-detail` and `profile`) and the controller's
own `Setpoints` struct + example/default TOML are updated in lockstep, so the in-toolchain
conformance test (`climate-controller/tests/config.rs`) and the contract harness stay green.

**Why:** VPD is the agronomically correct variable governing transpiration; controlling temperature
and humidity to independent setpoints lets both hit target while VPD sits wrong, and the unused
`vpd_target_kpa` field showed the design already anticipated this. A feedforward (derive the humidity
setpoint from VPD + measured temperature, then run the existing hysteresis) makes the VPD target
load-bearing without adding a new control tier or a VPD PID — you cannot actuate VPD directly, only
temperature and humidity. Keeping `humidity_low/high` as a clamp preserves a legible safety envelope
and a sensor-fault fallback, so the change is strictly additive to safety. Specifying the behavior now
while deferring the math to its consumer keeps the config/contract surface honest without landing
unused code.

**Basis:** Operator-directed control-design change. Contract-versioning discipline per
[RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 2026-06-17 — Frontend WebSocket fan-out contract authored (JSON Schema 2020-12)

**Decision:** Authored the platform's live-push WebSocket fan-out under `contracts/frontend-ws/` as
**JSON Schema** (Draft 2020-12) — one file per frame type plus a shared envelope, a `common` of shared
`$defs`, a `message` union, a README, and example fixtures — filling the §2.5 "Phase 2 WebSocket
fan-out" entry in the [contract catalog](../specs/design/spec-contracts.md) that was previously "to
author," and formalizing the live-push half of the *client's working contract* sketched in the
[frontend data model §5](../specs/design/frontend/05-spec-frontend-data-model.md#5-websocket-message-taxonomy).
With this and the [REST contract](../../contracts/frontend-rest/), the data model's documented
"Go-API ↔ SPA REST/WS" gap is now fully closed. The surface is the four frames the platform pushes to
the SPA (frontend data model §5, platform interfaces §3): `telemetry`, `status`, and `event`
(slice **2a**), and `drift` (slice **2b**). Shape choices settled while authoring:

- **JSON Schema, modeled on `contracts/mqtt/` (not OpenAPI/AsyncAPI).** The WebSocket fan-out is an
  envelope-based push channel — the MQTT contract, not the REST ones, is its structural analog. JSON
  Schema is the format RFC-007 §5 fixes for message schemas (AsyncAPI is explicitly only an optional
  later doc layer), so the frames reuse the MQTT idioms directly: a shared `envelope.schema.json`
  composed via `allOf`, closed enums, the metric→unit `if/then` binding, `unevaluatedProperties:
  false`, stable `$id`s under a local base, and Ajv-validated positive + `*.bad-*.json` fixtures. No
  new dependency or tooling.
- **Flat frames, not a `{ type, data }` wrapper.** Each frame is the RFC-007 envelope, a `type`
  discriminator, and the payload all at the top level — the same layout as an MQTT message, with
  `type` added — rather than nesting the payload under `data`. The `{ type, data }` union in data
  model §5 is illustrative; the wire shape is flat, and `message.schema.json` is the `oneOf` a consumer
  validates each frame against (unknown `type` ignored — additive frame types do not bump the major).
- **Push only; subscription stays out of the contract.** The contract is the server→client frames.
  The SPA "subscribes to the greenhouses currently in view," but that granularity is server-decided
  (frontend architecture §4) and is deliberately *not* wire-contracted — there are no client→server
  frames. Matches the catalog's stated Platform → SPA direction.
- **Frames carry the envelope; `schema_version` is an integer.** Unlike the REST bodies (no envelope),
  every frame carries the RFC-007 envelope, like MQTT — so the `event` frame is the frontend-rest
  `EventEntry` with its `greenhouse_id`/`ts` lifted into the envelope, and `schema_version` is an
  **integer** major (the data model §2 `z.string()` sketch is illustrative). `status`/`drift`/`event`
  pin `zone_id` to `null` (greenhouse-scoped); `telemetry` may be zone-scoped.

Connection lifecycle (reconnect/backoff, backfill, polling fallback, the `ConnectionStatus` indicator)
is **not** redefined here — it is owned by the frontend specs (architecture §4, interactions §5) and
referenced; the indicator derives from the socket's own state, so there is no heartbeat frame.
Validation mirrors the MQTT contract — an Ajv (Draft 2020-12, strict) run of each fixture against its
frame schema and the union, with two negative fixtures that must fail — and automating it stays the
same `contracts/` [backlog](../backlog.md) item.

**Why:** `contracts/` is the single artifact all phases conform to, and the WebSocket fan-out — the
SPA's entire live-data contract with the platform — had a catalog entry and a client-side sketch but
no normative schema. Authoring it gives the Go API (producer) and the SPA (consumer) one artifact to
build against and lets the SPA's Zod schemas validate against it. Reusing the MQTT JSON-Schema idioms
keeps one validation discipline across all four contracts and a single shared identity/envelope end to
end; flat frames keep the layout uniform with the other push channel rather than introducing a wrapper
shape unique to this surface.

**RFC:** [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)

---

## 2026-06-17 — Frontend (operator/fleet) REST API contract authored (OpenAPI 3.1)

**Decision:** Authored the platform's operator/fleet REST API under `contracts/frontend-rest/` as an
**OpenAPI 3.1** document (`openapi.json`) plus a README and example fixtures — filling the §2.4
"Phase 2 operator/fleet REST API" entry in the [contract catalog](../specs/design/spec-contracts.md)
that was previously "to author," and formalizing the REST half of the *client's working contract*
sketched in the [frontend data model](../specs/design/frontend/05-spec-frontend-data-model.md). The
surface is the SPA's consumed REST endpoints (frontend data model §6, platform interfaces §3): fleet
list + registration, per-greenhouse detail, ad-hoc setpoint edits, telemetry range queries, and the
activity feed (slice **2a**); crop-profile CRUD and assignments (slice **2b**). Shape choices settled
while authoring:

- **Directory named by consumer (`frontend-rest/`).** The controller contract is named for its server
  (`controller-rest/`), but the platform serves *two* REST contracts — this operator/fleet surface and
  the optimizer-facing single-authority setpoint API (catalog #3) — so a server-based `platform-rest/`
  name would be ambiguous; named for the consumer instead.
- **REST only.** The live-push **WebSocket** fan-out (catalog #5) stays a separate, still-to-author
  contract; this document is the request/response half. The data model's "Go-API ↔ SPA REST/WS"
  documented gap now narrows to WebSocket-only.
- **snake_case wire format, no REST envelope.** Field names are snake_case (`greenhouse_id`,
  `temperature_day_c`) to match the MQTT and controller-rest contracts and
  [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format);
  the SPA maps them to its camelCase Zod types. Unlike MQTT/WS frames, REST bodies are **not** wrapped
  in the RFC-007 `schema_version` envelope (matching controller-rest) — identity is embedded directly
  and the contract version is `info.version`.
- **Slice-dependent auth.** A `bearerAuth` (Keycloak OIDC/JWT) scheme is declared and applied to 2b
  operations, with writes restricted to the operator role; 2a operations declare `security: []` —
  unauthenticated on the trusted Docker network
  ([RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
  This differs from controller-rest (unauthenticated in every mode), so this contract carries
  `securitySchemes`.
- **Target bundle mirrors the controller's runtime config.** The `Setpoints` bundle reuses the
  controller-rest climate fields and bounds plus per-zone irrigation, so a resolved crop profile maps
  directly; zone *topology* stays controller-local and out of the write path (platform data model §3).

A rejected write returns **422** with a `ValidationError` naming the violated `field` and `bound` —
the same shape controller-rest returns and the platform relays under
[RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain). Validation mirrors
the other contracts — a 3.1-aware Redocly lint of `openapi.json` plus an Ajv (Draft 2020-12) run of
each fixture against its component schema, with two negative fixtures that must fail — and automating
it stays the same `contracts/` [backlog](../backlog.md) item.

**Why:** `contracts/` is the single artifact all phases conform to, and this operator/fleet surface —
the SPA's entire request/response contract with the platform — had a catalog entry and a client-side
sketch but no normative schema. Authoring it gives the frontend and the Go API one artifact to build
against and lets the SPA's Zod schemas validate against it. Reusing OpenAPI 3.1 / JSON Schema 2020-12
keeps one validation discipline across MQTT, controller-rest, and this contract; `/api`-prefixed,
greenhouse-scoped paths and the shared slug identity keep the model uniform end to end.

**RFC:** [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
[RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
[RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)

---

## 2026-06-16 — Actuator-health monitoring, observed actuator channel, and MQTT connection-resilience model

**Decision:** Close four controller failure gaps surfaced by
[`research/failures-controller.md`](../../research/failures-controller.md) — actuator no-effect,
stuck actuator, actuator saturation, and MQTT publish-lag/disconnect — that the controller spec set
previously handled only for irrigation or left unspecified.

1. **Actuator-health monitoring** becomes a first-class concern, the output-side counterpart to
   sensor fault detection, owned by
   [safety §5](../specs/design/controller/06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring).
   It distinguishes three conditions with deliberately different responses: **stuck**
   (`observed ≠ commanded` → disable + alarm), **no-response** (obeys but no climate effect →
   disable + alarm), and **saturation** (working but pinned at its limit → **alarm, keep
   controlling, never disable**). Saturation / `setpoint_unreachable` detection is owned by the
   [loops](../specs/design/controller/05-spec-controller-control-loops.md#saturation--setpoint-unreachable).
2. **The HAL gains an `observed` actuator readback** distinct from the commanded value, plus
   **seeded actuator-fault injection** (stuck/no-effect), so the monitor is testable deterministically
   ([HAL §8](../specs/design/controller/03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection)).
3. **MQTT connection resilience** is specified
   ([interfaces §7](../specs/design/controller/08-spec-controller-interfaces.md#7-mqtt-connection-resilience)):
   publishing is decoupled from control and never blocks the tick; a bounded outbound queue drops
   rather than accumulates under backpressure; reconnect re-primes subscribers from the retained
   state snapshot; telemetry lost while disconnected is a recoverable data gap.
4. **Two NFRs** are added — **P1-REL-4** (actuator stuck/no-response detection within a configurable
   window) and **P1-RESIL-3** (publish never blocks control) — keeping the new behavior traceable.

**Contract changes (breaking):** the MQTT `fault-event` and REST `FaultSummary` enums gain
`actuator_stuck` / `actuator_no_response` / `setpoint_unreachable`; `actuator-state` (and the
`system-state` actuator entries) replace the single `state` with `commanded` + `observed` + a
`health` enum. Because Phase 1 is not yet implemented and **no consumer is deployed**, the schemas are
edited **in place at major `schema_version` 1** rather than retained side-by-side; once a controller or
platform consumes these, the same change would instead bump the major per
[`contracts/README.md`](../../contracts/README.md). Example fixtures (including the `bad-level`
counter-example) are updated to the new shape and a `fault-event.actuator-stuck` fixture is added.

**Why:** Sensing had a full fault/fusion/degradation ladder while actuators were rigorously handled
only for irrigation — a controller commanding a dead, jammed, or undersized actuator would push
harder against a plant that never responds, with no detection or alarm. The observed-vs-commanded
channel is the minimal mechanism that makes stuck/jammed faults detectable and finally backs the
interfaces spec's long-standing "commanded + observed" wording. Decoupling telemetry from the tick
ensures a broker outage degrades observability, never control.

**Basis:** Operator-directed gap closure from `research/failures-controller.md` (gaps 1, 2, 3, 6).
Gaps 4 (interlock debounce) and 5 (min-cycle vs safety) are intentionally deferred.

---

## 2026-06-11 — Phase 1 local dashboard and WebSocket interface eliminated; Phase 2 frontend is the sole UI

**Decision:** Remove the Phase 1 controller's **local dashboard** and the controller-side
**WebSocket** stream that fed it. This **reverses** the 2026-06-01 "Phase 1 dashboard: SvelteKit"
decision (that ADR entry is removed) and retires the controller WebSocket contract authored on
2026-06-09 (`contracts/controller-websocket/` is deleted). The controller's only external surfaces
are now **MQTT** (telemetry out) and **REST** (the sole write path). The controller is **headless**:
in standalone Phase 1, telemetry is observed via MQTT tooling (e.g. MQTT Explorer) and the REST
surface directly. The **Phase 2 React frontend becomes the only UI in the system**, monitoring
**one or more** greenhouse controllers — a single greenhouse is simply the fleet-of-one case.

**Why:** With the dashboard gone the WebSocket surface had no consumer — MQTT already fans telemetry
out to any upstream consumer and REST remains the command path, so the controller WebSocket frame
set, its AsyncAPI contract, and the SvelteKit toolchain were carrying no load. Consolidating all
visualization into the Phase 2 frontend removes a second frontend framework and a Node/JS toolchain
from an otherwise all-Rust phase, and gives the controller a cleaner control-process boundary (MQTT +
REST only). The cost — Phase 1 has no UI of its own during standalone development — is accepted: the
control logic is exercised through tests and inspected through MQTT/REST, and any dashboard need is
met by bringing up the Phase 2 stack (see the 2a slice below).

**Basis:** Operator-directed architecture change; reverses the 2026-06-01 SvelteKit decision. No RFC
governed the Phase 1 dashboard or WebSocket stream (they lived in P1 §11 and the tech-stack docs).

---

## 2026-06-11 — Phase 2 split into delivery slices 2a (monitoring + setpoint edits) and 2b (profiles, auth, observability)

**Decision:** Split Phase 2 into two delivery slices. **Phase 2a** is the minimum for the Phase 2
frontend to talk to a controller in **both directions**: MQTT telemetry ingestion into TimescaleDB,
telemetry REST queries, WebSocket fan-out to the SPA, manual greenhouse/endpoint registration, and
**ad-hoc setpoint edits relayed to the controller's REST `PATCH /setpoints`** — served by the Go API
behind nginx, **unauthenticated** on the trusted local Docker network. **Phase 2b** adds everything
else: crop profiles and setpoint **resolution**, reconciliation / drift detection / re-assert on
reconnect, Keycloak OIDC with viewer/operator roles (and the nginx `/auth` route), the bounds-enforced
single-authority setpoint API (`POST /setpoints`, the optimizer's RFC-005 write path) with provenance,
Prometheus/Grafana observability, and the profile-management UI.

| Capability | Slice |
|---|---|
| Mosquitto broker; TimescaleDB (telemetry + minimal registry) | 2a |
| Go API: MQTT ingest → DB, telemetry REST, WebSocket fan-out, greenhouse registration | 2a |
| Go API: ad-hoc setpoint edits relayed to controller REST | 2a |
| nginx (SPA + `/api`, no `/auth`); React fleet overview + per-greenhouse detail + setpoint-edit control | 2a |
| Crop profiles + setpoint resolution; profile-management UI | 2b |
| Reconciliation / drift detection / re-assert on reconnect | 2b |
| Keycloak OIDC + roles + `/auth`; single-authority `POST /setpoints` + provenance | 2b |
| Prometheus + Grafana observability | 2b |

**Why:** Making the Phase 2 frontend the system's only UI ([see the entry above](#2026-06-11--phase-1-local-dashboard-and-websocket-interface-eliminated-phase-2-frontend-is-the-sole-ui))
means a usable monitoring surface for even a single greenhouse now depends on Phase 2 — so the
telemetry pipeline (MQTT → API → DB → WebSocket → React) plus a thin setpoint-edit relay is the real
MVP, and is worth delivering before the platform's defining-but-heavier crop-profile/reconciliation
machinery. Deferring Keycloak keeps 2a light and is consistent with
[RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)'s
posture that the local Docker network is the trust boundary. The split changes **no** committed
interface: 2a's ad-hoc edits are a thin relay (operator edit → Go API → controller REST), and the
full RFC-005 authority layer — crop-safe bounds, provenance, the optimizer-facing `POST /setpoints`,
reconciliation — lands intact in 2b. RFC-001/002/003/005/007/009 are all unaffected.

**Basis:** Operator-directed delivery sequencing; no interface change, so no RFC. Recorded here as
the home for the 2a/2b boundary; the Phase 2 spec carries the per-section tags.

---

## 2026-06-11 — Phase 3 LLM integration: LangChain replaces custom PlannerBackend internals

**Decision:** The `PlannerBackend` protocol from RFC-004 is replaced by a LangChain `Runnable`
chain as the planner implementation. The chain is `ChatPromptTemplate | LLM | StructuredOutputParser`,
constructed with `.with_structured_output(ActuatorPlan)` for plan parsing. `ChatAnthropic` /
`ChatOpenAI` (packages `langchain-anthropic`, `langchain-openai`) replace the bespoke hosted-backend
implementation; `ChatOllama` (package `langchain-community`) replaces the bespoke Ollama backend.
Fallback routing uses LangChain's native `.with_fallbacks([ChatOllama(...)])` instead of the manual
try/catch retry in the Proposal. The call site changes from `backend.generate_plan(context)` to
`chain.invoke(context_dict)`. `ActuatorPlan`, `PlanContext`, the five invocation-strategy levers
and their values, the constraint validation layer, and the configuration structure are all unchanged.
This change is internal to the planner component; no other RFC is affected.

**Why:** LangChain provides prompt templating, LLM routing, fallback chaining, and structured-output
parsing as tested, maintained abstractions — eliminating custom code for each of those concerns.
`.with_fallbacks()` expresses the hosted→Ollama fallback topology in one declaration rather than a
try/catch wrapper, making the intent explicit and reducing the surface for subtle retry bugs.
`.with_structured_output(ActuatorPlan)` ties the output parser directly to the existing Pydantic
model, so LLM output validation and the constraint engine use the same schema. Consistent with the
design doc principle that Phase 3 is "flexible by design — this layer evolves as LLM capabilities
do."

**RFC:** [RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)

---

## 2026-06-09 — Controller REST API contract authored (OpenAPI 3.1, greenhouse-scoped)

**Decision:** Authored the controller's REST contract under `contracts/controller-rest/` as an
**OpenAPI 3.1** document (`openapi.json`) plus a topic-map-style README and example fixtures —
filling the §2.2 "Controller REST API" entry in the
[contract catalog](../specs/design/spec-contracts.md) that was previously "to author." The
surface is exactly the responsibilities in controller spec §11: global setpoints (`GET`/`PATCH
/setpoints`), irrigation-zone status (`GET /zones`, `GET`/`PATCH /zones/{zone_id}`),
manual-override management (`GET /overrides`, `PUT`/`DELETE /overrides/{actuator}`), and system
health (`GET /health`). Two shape choices were settled while authoring:

- **OpenAPI 3.1 as the artifact.** It uses the same JSON Schema 2020-12 dialect the MQTT contract
  already uses (RFC-007), so the two contracts share a validation dialect, while OpenAPI natively
  expresses the paths, methods, and status codes a REST surface needs. Request/response bodies are
  `components.schemas`; the actuator enum, `{ on, level_pct }` output state, and fault summary are
  **inlined** (not cross-folder `$ref`'d) but documented as kept in sync with `contracts/mqtt/`.
  The document is split for navigability — one file per path under `paths/`, shared
  schemas/parameters/responses under `components/`, with `openapi.json` as the `$ref` entry point;
  `redocly bundle` re-emits a single self-contained file for tools that want one.
- **Greenhouse-scoped paths** (`/greenhouses/{greenhouse_id}/...`). A controller process is a
  single greenhouse, but scoping the paths under the identity keeps RFC-007's "same slug in MQTT
  topics, REST paths, and DB rows — no translation layer," and makes the platform's downward
  setpoint delivery (RFC-005) a direct pass-through of the identity it already holds.

Only the runtime-mutable surfaces accept writes; adding/removing a zone stays config-file + restart
(spec §4), so there is no zone create/delete. A rejected write returns **422** with a
`ValidationError` naming the violated `field` and `bound` — the shape Phase 2 relays under RFC-005;
cross-field invariants JSON Schema can't express (e.g. `humidity_low_pct < humidity_high_pct`) are
controller-enforced and surface as the same 422. Per RFC-009 the API declares **no**
`securitySchemes` — it is unauthenticated, trusted on the local Docker network.

**Why:** `contracts/` is the single artifact all phases conform to, and this REST surface — the
controller's only inbound write path and the REST leg of the RFC-005 setpoint chain — had a catalog
entry but no schema. Reusing the JSON Schema 2020-12 dialect (via OpenAPI 3.1) keeps one validation
discipline across MQTT and REST and lets the same Ajv tooling check the fixtures; greenhouse-scoped
paths keep the identity model uniform end to end. Validation mirrors the MQTT contract — a 3.1-aware
lint plus an Ajv run of each fixture against its component schema, with two negative fixtures that
must fail — and automating it stays the same `contracts/` backlog item.

**RFC:** [RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
[RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
[RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)

---

## 2026-06-09 — MQTT contract schemas authored (implements RFC-007)

**Decision:** Wrote the first `contracts/mqtt/` schemas under the RFC-007 conventions — five
message types as JSON Schema (Draft 2020-12), plus a topic-map README and example fixtures. The
shared envelope lives in `envelope.schema.json` and is composed into every message via `allOf`;
each schema carries a stable `$id` under base `https://greenhouse.local/contracts/mqtt/` so
cross-schema `$ref`s resolve by `$id` in all three stacks. Message types:
`sensor-reading`, `actuator-state`, `fault-event`, `system-state`.

Three shape choices were settled while authoring:
- **Sensor units** are bound to the metric (`if/then`: `temperature` ⇒ `°C`, etc.), so a
  mismatched unit is rejected at the contract boundary, not just discouraged by the units table.
- **Actuator state** is one unified shape `{ on, level_pct }` for all eight actuators —
  `level_pct` is `0–100` for variable/modulating devices and `null` for pure on/off devices —
  rather than per-type sub-schemas. One shape for the ingester to handle.
- The retained **`gh/{id}/state`** topic is a **full snapshot**: latest house sensors, every
  actuator state, per-zone irrigation status, active faults, active overrides, and controller
  mode/health. The actuator and fault shapes are `$ref`'d from their owning schemas so the
  snapshot cannot drift from the per-topic messages.

This also closes two RFC-007 open questions: `metric`/`actuator` names are **closed enums**, and
**only** the consolidated `state` topic is retained (no per-sensor retain).

**Why:** `contracts/` is the single artifact all three phases conform to, and RFC-007 explicitly
deferred writing the first schema. Binding units and using closed enums turns the conventions into
checks that actually bite (proven by two negative fixtures that must fail validation). A single
envelope source and `$ref`-shared `$defs` keep the contract DRY and drift-free; per-language `$id`
resolution is documented in `mqtt/README.md`. The scope ambiguity for `par` (RFC-007 examples vs
the physical/controller specs) is sidestepped: the sensor-reading schema is scope-agnostic — any
metric is valid on either the greenhouse or zone topic, with scope carried by the topic and
envelope `zone_id`.

**RFC:** [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)

---

## 2026-06-08 — Internal trust model: no service-to-service auth; authentication is human-only

**Decision:** Authenticate **human actors only**; the non-human, service-to-service boundaries are
**not** authenticated and rely on the trusted local Docker Compose network. This **reverses the
RFC-009 proposal** (a Keycloak service-account client-credentials grant for the optimizer plus a
per-controller pre-shared bearer token); neither is adopted. The committed boundaries:
(1) **Human → platform** — Keycloak OIDC, unchanged ([P2 authentication](../specs/design/platform/07-spec-platform-security.md));
the only authenticated boundary. (2) **Optimizer → Phase 2 API** (setpoint writes) — no service
token; trusted on the internal network. (3) **Platform → controller REST** — no controller-side auth;
the REST config/override API stays unauthenticated in managed mode exactly as standalone, protected
only by Docker network isolation. (4) **Optimizer → Phase 2 DB** — unchanged: the read-only
`optimizer_ro` role ([RFC-008](./request-for-comments.md#rfc-008-phase-3-telemetry-read-path)), a
least-privilege database credential rather than service authn. (5) **MQTT** — anonymous on the local
network, unchanged ([RFC-001](./request-for-comments.md#rfc-001-mqtt-broker-selection)).

**Why:** The threat model is a single-machine, local Docker Compose portfolio system, where the host
network is itself the trust boundary. Standing up service-credential machinery — Keycloak client
registration and token refresh in the optimizer, and per-controller token generation, registry
storage, and TOML provisioning — is operational surface disproportionate to a one-laptop deployment;
it is the same reasoning RFC-009 used to reject mTLS, applied consistently to the token mechanisms.
Keeping authentication human-only preserves a single auth concept (Keycloak OIDC for people) with no
second authn path for services. The cost is accepted explicitly: any process reachable on the Docker
network (or a published port in dev) can call the controller REST API or the Phase 2 setpoint
endpoint, and optimizer setpoint provenance (`source = optimizer`, RFC-005) is recorded by the
application but self-asserted rather than backed by a verified token identity. If the system ever
leaves the single-host local model, the controller's REST API and the registry's controller-endpoint
record are the seams to add a per-controller token, and the optimizer the place to add a service
account.

**RFC:** [RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)

---

## 2026-06-08 — Phase 3 telemetry read path: direct read-only DB access via a versioned view surface

**Decision:** The optimizer reads historical telemetry by connecting **directly** to Phase 2's
TimescaleDB, but the schema coupling is contained. (1) It connects as a dedicated `optimizer_ro`
Postgres role with `SELECT`-only grants — no access to the relational write tables (registry, crop
profiles, assignments, users) beyond the read surface, and no `INSERT/UPDATE/DELETE` anywhere. (2) The
grants are on a small set of **named views** owned by Phase 2 (e.g. `optimizer_sensor_readings`,
`optimizer_actuator_states`), not on the raw hypertables — the views are the contract boundary, so
Phase 2 may refactor the physical tables freely as long as it preserves the views. (3) That read
surface is **versioned like a contract**: a breaking change to a view's shape is an ADR event under
the same RFC-007 discipline as the wire contract (additive is free; breaking is announced and the
previous shape kept side-by-side during transition). The RFC-004 hourly `(min, mean, max)` summaries
may be backed by a TimescaleDB continuous aggregate exposed through the surface. The write path is
unchanged — setpoints flow only through the Phase 2 API per RFC-005.

**Why:** A read carries no authority and no safety concern (it cannot drive the greenhouse unsafe), so
the strict single-authority routing RFC-005 imposed on *writes* is not needed for reads. The
optimizer's workload — range scans over high-volume time-series plus hourly windowed aggregates — is
exactly what TimescaleDB's SQL and continuous aggregates do well and what a Phase 2 REST query API
would have to re-implement over HTTP for a single internal consumer. The real cost of direct access is
coupling to Phase 2's internal schema; granting on views instead of raw tables is a near-zero-cost
change that buys a stable boundary, giving Phase 3 the same protection against Phase 2 schema churn
that all three phases already have against the MQTT wire contract. Replicating telemetry into a
Phase 3-owned store was rejected as duplicating the storage/retention problem RFC-002 already solved;
a REST query API was rejected as building and maintaining HTTP endpoints whose only consumer is one
service. The view surface can be promoted to a REST API later if a second external consumer appears.

**RFC:** [RFC-008](./request-for-comments.md#rfc-008-phase-3-telemetry-read-path)

---

## 2026-06-07 — Contract conventions: topic taxonomy, identity, payload envelope, JSON Schema

**Decision:** Fix the conventions that govern `contracts/` before any schema file is written.
(1) **Identity** — a single `greenhouse_id` / `zone_id` pair, both lowercase kebab slugs, used
verbatim as the keys in MQTT topics, REST paths, and DB rows (no UUIDs, no translation layer).
(2) **MQTT topic taxonomy** — hierarchical `gh/{greenhouse_id}/...` with a greenhouse- vs zone-scoped
split mirroring the physical model; QoS 1 on all telemetry; retained only on the consolidated
`gh/{id}/state` topic. MQTT is **telemetry-only** — the controller subscribes to nothing and there
are no command/plan topics. (3) **Payload envelope** — every message carries `schema_version`,
`greenhouse_id`, `zone_id`, and `ts` (RFC 3339 UTC, ms precision), plus a fixed units convention
(°C, %RH, ppm, %VWC, µmol·m⁻²·s⁻¹, kPa). (4) **Schema format & versioning** — JSON Schema
(Draft 2020-12) is the normative artifact, one file per message type under `contracts/mqtt/`;
`schema_version` is an integer major, additive/backward-compatible changes do not bump it, breaking
changes bump and run side-by-side during transition. Each contract change carries an ADR.

**Why:** `contracts/` is the single artifact all three phases (Rust, Go, Python) conform to, yet RFCs
001–006 each settled a *component* and none designed the wire contract itself — the highest-blast
-radius decision in the system, since changing it later means editing three codebases at once. The
specs uniformly defer wire formats to `contracts/`, so these conventions had to be decided before the
first schema. Slugs over UUIDs because the system is local and single-site and the controllers are
named, config-generated services (RFC-003) — readable in topics, logs, and the MQTT tree. JSON Schema
over AsyncAPI because validation is needed in all three stacks with no intermediate tooling; AsyncAPI
can wrap it later as docs. A common envelope lets a multi-greenhouse ingester attribute and validate
each message independently. The decision also resolves a standing doc inconsistency: post-RFC-005 the
controller is setpoint-only with setpoints over REST, so MQTT is telemetry-only — the stale
"actuator command/plan over MQTT" references in `contracts/README.md`, `high-level-idea.md`, and
`spec-climate-controller.md §11` are corrected to match.

**RFC:** [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)

---

## 2026-06-07 — Phase 4 seam: HAL actuator interface must not assume one actuator → one variable

**Decision:** Implement Phases 1–3 exactly as specified, with a single forward-looking constraint on
the Phase 1 HAL: the actuator interface (trait) must model an actuator as producing a *set of effects
on climate variables*, not a one-to-one actuator→variable mapping. The existing simulated actuators
each happen to affect mostly one variable, but the interface must not encode that as an invariant.
Nothing else is built ahead of Phase 4 — no combustion-heater implementation (not even behind a
flag), no weather/forecast ingestion, and no actuator-selection coordination layer above the PIDs.

**Why:** Phase 4's combustion heater is one device that raises temperature, CO₂, and humidity at
once, breaking the independent-loop assumption. If the HAL trait hard-codes one actuator → one
variable, adding the burner in Phase 4 forces a HAL rewrite; shaping the trait correctly now makes
the burner a new HAL backend implementing the same trait — additive, not a rewrite. The constraint
is zero-cost and provably contained: the actuator→variable coupling already lives in the HAL
simulation's coupling matrix, not in the control loops (the PIDs target variables, not actuators), so
it does not bleed Phase 4 complexity into the rule engine or PID wiring. Building anything more ahead
of Phase 4 (combustion logic, weather feeds, coordination) was rejected as premature — it would raise
the complexity of layers that should stay at their Phase 1–3 ratings until Phase 4 is actually in
scope.

**RFC:** [RFC-006](./request-for-comments.md#rfc-006-phase-4-seam-strategy)

---

## 2026-06-07 — Setpoint authority: Phase 2 is the single authority

**Decision:** Phase 2 is the single authority for controller setpoints. Every setpoint source — crop
-profile assignment, operator override, and the Phase 3 optimizer — writes through the Phase 2
setpoint API. Phase 2 enforces crop-safe bounds, records provenance (source = `crop_profile`,
`optimizer`, or `manual_override`, with timestamp and value), and is the sole delivery path to the
Phase 1 controller via the controller's REST config API. The optimizer submits refined targets via
`POST /greenhouses/{id}/setpoints` (with an `optimizer_run_id` for tracing) and never writes to the
controller directly or over MQTT.

**Why:** Phase 2 already holds the crop-safe bounds (from crop profiles) and is the source of truth
for intended state. Routing every setpoint source through it keeps bounds enforcement and provenance
in one place, rather than re-implementing validation in the optimizer and splitting the audit trail
across systems. The alternatives — optimizer publishing over MQTT or calling the Phase 1 REST API
directly — each create a second setpoint authority and a direct Phase 3 → Phase 1 dependency the
layer separation is designed to prevent. The latency cost of the extra hop is irrelevant: setpoint
changes are minutes-scale (the optimizer's planning cadence, per RFC-004), not real-time actuator
commands.

**RFC:** [RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)

---

## 2026-06-07 — Phase 3 LLM integration: hosted primary, Ollama fallback, backend-agnostic strategy

**Decision:** Use a hosted LLM (Anthropic or OpenAI) as the primary planning backend, with Ollama
as the local fallback when the hosted backend is unreachable or unconfigured. Both backends
implement a `PlannerBackend` protocol; the planning loop is identical regardless of which is active.
A single backend-agnostic invocation strategy — fixed token budget (4 000 tokens), hourly telemetry
summaries, 12-hour adaptive horizon, state-change gate (5% deviation threshold), and 30-minute
cycle cadence — is applied in the serialization layer before any backend call.

**Why:** Hosted frontier models produce more reliably constraint-valid multi-variable plans than
7B–13B local models. Docker Desktop containers have outbound internet access by default, so the
network dependency is low friction. The Ollama fallback preserves planning continuity during
transient hosted-backend outages without requiring a code change. The backend-agnostic invocation
strategy is necessary because local models have small context windows (4K–8K tokens) and slow
inference, while hosted models have per-token cost — a single conservative budget sized for the
local model addresses both concerns simultaneously, with no per-backend branching in the optimizer.

**RFC:** [RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)

---

## 2026-06-07 — Phase 2 ingress: single nginx (SPA server + reverse proxy)

**Decision:** Use one nginx container as the platform's single entry point — it serves the built
React SPA and reverse-proxies `/api` and `/auth` to the Go API and Keycloak. Traefik is not used.

**Why:** The routing map is static — the platform services and the generated controllers are named,
config-driven Compose services (controllers are generated as named services, not
`docker compose --scale` replicas). Traefik's core advantage is runtime service discovery, which
brings no benefit when there is nothing to dynamically discover. nginx already serves the SPA
regardless, so folding the `/api` and `/auth` proxy rules into that same container adds one config
file and no new component. Static `proxy_pass` upstreams are exactly nginx's strength when the
service map does not churn. A single entry point also keeps OIDC redirect URIs stable. Local TLS,
if needed later, terminates at this same nginx as a config addition.

**RFC:** [RFC-003](./request-for-comments.md#rfc-003-phase-2-platform-ingress)

---

## 2026-06-07 — Phase 2 store: TimescaleDB from day one

**Decision:** Use TimescaleDB (the PostgreSQL extension) as Phase 2's single store from the first
migration. Relational metadata (greenhouse registry, crop profiles) lives in ordinary tables; the
high-volume telemetry tables (`sensor_readings`, `actuator_events`) are created as hypertables in
the initial migration, with retention/compression policies applied from the start.

**Why:** The telemetry workload is unambiguously time-series, so the adoption question is *when*,
not *whether*. Because TimescaleDB is a Postgres extension — not a separate database — it serves the
relational metadata with stock PostgreSQL semantics in the same instance, and relational tables and
hypertables coexist and join normally. Committing on day one removes a later image-swap +
`create_hypertable` + policy cutover and gives correct telemetry physical layout (time-range
chunking, retention) from the first insert.

**RFC:** [RFC-002](./request-for-comments.md#rfc-002-phase-2-persistence-layer)

---

## 2026-06-07 — MQTT broker: Mosquitto

**Decision:** Use Mosquitto as the MQTT broker for all phases.

**Why:** The required feature set is QoS + retained messages, which Mosquitto covers with the
smallest footprint and simplest configuration. The system is single-site and local-only — EMQX's
dashboard, clustering, and per-client ACLs provide no benefit at this scale. The abstraction is
pure MQTT, so swapping to EMQX later is a Compose and config change, not a code change.

**RFC:** [RFC-001](./request-for-comments.md#rfc-001-mqtt-broker-selection)

---

## 2026-06-06 — Phase 3 digital twin: NumPy / SciPy forward model

**Decision:** Build the Phase 3 digital twin — the forward model that rolls temperature, humidity,
CO₂, VPD, and DLI over the planning horizon — on **NumPy and SciPy**. The coupled first-order lag
dynamics, the actuator coupling matrix, and trajectory integration are expressed as NumPy arrays and
SciPy numerical routines ([P3 §3](../specs/design/optimizer/03-spec-optimizer-digital-twin.md#1-the-forward-model)).

**Why:** The twin is small-dimensional numerical integration over a coupling matrix — exactly the
vectorized, C-backed linear-algebra and ODE work NumPy/SciPy are built for. They are the de-facto
standard for this in Python, so they sit naturally alongside the Python optimizer and its LLM SDKs
with no second runtime. Heavy inner loops execute in compiled C, so the simulation is fast despite
the Python host.

**Alternatives considered:** *Pure-Python loops* — no dependency, but interpreted per-step math is too
slow for repeated horizon rollouts. *PyTorch / JAX* — fast and differentiable, but autodiff and GPU
tensors are unneeded for first-order lag and add heavyweight dependencies. *A physics engine /
Modelica-class simulator* — far more fidelity than the deliberately bounded first-order-lag model
calls for ([P3 §3](../specs/design/optimizer/03-spec-optimizer-digital-twin.md#1-the-forward-model)).

**Tradeoffs accepted:** NumPy/SciPy are non-trivial dependencies and not as fast as a fully compiled
model — acceptable because the planning cadence is minutes-scale (default 30 min,
[RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)) and the vectorized
core comfortably covers a single greenhouse's rollout.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-06 — Phase 3 service API: FastAPI

**Decision:** Expose the optimizer's service surface — trigger planning cycles, inspect proposed
plans, review escalations, report health — with **FastAPI**
([P3 §2](../specs/design/optimizer/02-spec-optimizer-architecture.md),
[§8](../specs/design/optimizer/09-spec-optimizer-interfaces.md)).

**Why:** FastAPI's Pydantic models give declarative request/response validation that lines up
directly with the JSON-Schema-first contract discipline of
[RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
and they are the same models used to validate the structured plan the LLM emits
([P3 §4](../specs/design/optimizer/04-spec-optimizer-planning.md#1-llm-driven-planning)) — one validation tool for
both the API boundary and the planner output. Async I/O suits a service that calls hosted LLM and
Phase 2 REST endpoints, and the auto-generated OpenAPI docs are useful for an operator/tooling
surface.

**Alternatives considered:** *Flask* — ubiquitous, but synchronous and without built-in
validation/serialization (would bolt on `marshmallow` + an async server). *Django / DRF* — a full ORM
and admin stack the optimizer does not need; it owns no relational data (it reads Phase 2's store and
writes the Phase 2 API). *Bare ASGI* — no batteries; reimplements what FastAPI already provides.

**Tradeoffs accepted:** async adds some concurrency-reasoning overhead, and FastAPI is younger and
less universally known than Flask — outweighed by the Pydantic/contract alignment and async fit.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-05 — Phase 3 optimizer language: Python

**Decision:** Implement the Phase 3 optimizer — the intelligence layer that simulates each
greenhouse forward, plans with an LLM, validates, and writes refined setpoints — in **Python**
([P3 §1](../specs/design/optimizer/01-spec-optimizer-overview.md)).

**Why:** Phase 3's two demanding dependencies — scientific computing (the digital twin) and LLM
integration — both have their richest, best-maintained ecosystems in Python: NumPy/SciPy for the
simulation and first-class vendor SDKs (Anthropic, OpenAI) plus Ollama clients for the
backend-agnostic planner ([RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)).
Python's fast iteration also suits a layer the specs call "flexible by design — this layer evolves as
LLM capabilities do."

**Alternatives considered:** *Rust or Go* — strong elsewhere in the stack but with markedly thinner
scientific-computing and LLM-SDK ecosystems, forcing reimplementation or FFI for the very libraries
that motivate the choice. *Julia* — excellent numerics, but a smaller LLM-tooling ecosystem and less
common operational footing.

**Tradeoffs accepted:** Python's interpreter speed, the GIL, and dependency packaging are real, but
the optimizer is not on a real-time path — it plans on a minutes-scale cadence (default 30 min,
[RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)), the heavy math runs
in NumPy/SciPy's C core, and the dominant latency is the remote LLM call. Runtime speed is therefore
not the binding constraint. This sits opposite the Phase 1 controller's
[Rust](#2026-06-01--phase-1-controller-language-rust) real-time choice — deliberately, because the two
layers have opposite constraints.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-04 — Phase 2 observability: Prometheus + Grafana

**Decision:** Instrument the platform's **own** health with **Prometheus** scraping the Go API's
`/metrics` endpoint and **Grafana** rendering the dashboards, alongside structured logs
([P2 observability](../specs/design/platform/08-spec-platform-operations.md#1-observability),
[deployment](../specs/design/platform/08-spec-platform-operations.md#2-deployment)). This is platform-service telemetry
(ingestion rate, API latency/errors, reconciliation actions, per-controller connectivity) — distinct
from the greenhouse climate telemetry that lives in TimescaleDB and the dashboard.

**Why:** Prometheus + Grafana are the de-facto local, self-hosted metrics-and-dashboards pairing, so
they hold to the zero-cloud posture and add only two well-understood containers. They also give the
visibility needed for the platform's primary performance-testing mechanism — running a variable
number of controllers and watching the platform under load
([P2 deployment](../specs/design/platform/08-spec-platform-operations.md#2-deployment)).

**Alternatives considered:** *Logs only* — simplest, but no time-series view of ingestion rate or
latency, which the perf-testing story needs. *Hosted APM (Datadog, New Relic)* — turnkey but a cloud
dependency that breaks the local-only design. *Full OpenTelemetry + a separate backend* — more moving
parts than a single-site local platform warrants today; the Prometheus exposition format keeps an OTel
migration open later.

**Tradeoffs accepted:** two extra containers and a little dashboard upkeep for a local dev system —
arguably more ops surface than strictly required, accepted because it mirrors a real PaaS operations
posture and directly serves performance testing.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-04 — Phase 2 identity: Keycloak (self-hosted OIDC)

**Decision:** Delegate platform identity to **Keycloak**, a self-hosted OIDC identity provider
running as a container in the stack; the Go API is a relying party that validates Keycloak's tokens
and maps their roles onto the platform's viewer/operator roles
([P2 authentication](../specs/design/platform/07-spec-platform-security.md)). The API never
handles credentials itself.

**Why:** Keycloak owns the user store, login, password policy, and optional MFA, so none of that is
hand-rolled in the API — and being self-hosted it keeps the zero-cloud posture. It also concentrates
authentication in a single concept: [RFC-009](./request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)
later settled that authentication is **human-only** (services are trusted on the local Docker
network), which makes Keycloak OIDC the system's one and only auth mechanism.

**Alternatives considered:** *Roll-your-own auth in the API* — no extra service, but reintroduces
exactly the credential-handling, hashing, and session risk Keycloak removes. *Hosted IdP (Auth0,
Okta, Cognito)* — managed and capable, but a cloud dependency that breaks the local-only design.
*Lighter self-hosted IdPs (Authentik, Zitadel, Ory)* — viable, but Keycloak is the most established
OIDC option and standard token validation keeps it swappable.

**Tradeoffs accepted:** Keycloak is heavyweight (a JVM service with real memory cost and realm
configuration) for a two-role local platform. Accepted because it removes credential handling from
the API entirely and mirrors a realistic PaaS identity edge; the API's role-mapping is independent of
Keycloak internals, so the IdP can be replaced without touching the authorization rules.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-03 — Phase 2 dashboard: React single-page app

**Decision:** Build the operator dashboard as a **React single-page application** — fleet overview,
per-greenhouse detail, profile management, and control — served as a static bundle by the platform's
nginx and talking to the Go API over HTTP + WebSockets
([P2 dashboard](../specs/design/platform/06-spec-platform-dashboard.md)).

**Why:** The dashboard is a live, interactive client: real-time charts of readings vs setpoints and a
streaming event feed driven by the API's WebSocket fan-out
([P2 API surface](../specs/design/platform/09-spec-platform-interfaces.md#3-api-surface-inventory)). React's mature ecosystem
(component model, charting libraries, WebSocket integration) fits that directly, and a built static
bundle drops straight into the single-nginx entry point from
[RFC-003](./request-for-comments.md#rfc-003-phase-2-platform-ingress) with no extra serving component.

**Alternatives considered:** *Vue / Svelte / Angular* — all capable SPA frameworks; React chosen for
the largest ecosystem and charting/real-time library support, not a technical disqualifier of the
others. *Server-rendered HTML (Go templates) or HTMX* — lighter, no build toolchain, but a weaker fit
for many live-updating WebSocket-fed charts on one screen.

**Tradeoffs accepted:** an SPA brings a JS build toolchain and bundle-size considerations and pushes
view state to the client. Accepted for the real-time interactivity, and it pairs cleanly with the
existing nginx static-serve + reverse-proxy setup
([RFC-003](./request-for-comments.md#rfc-003-phase-2-platform-ingress)). This React SPA is the
**system's only frontend** — there is no separate Phase 1 dashboard (see the
[2026-06-11 entry](#2026-06-11--phase-1-local-dashboard-and-websocket-interface-eliminated-phase-2-frontend-is-the-sole-ui))
— and it serves **one or more** greenhouses, a single greenhouse being the fleet-of-one case. Its
monitoring core ships in the 2a slice; profile management and richer control follow in 2b.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-02 — Phase 2 API: Go + Echo

**Decision:** Implement the platform's API hub in **Go** using the **Echo** web framework. The Go API
is the platform's center: it ingests telemetry from MQTT, persists to TimescaleDB, resolves crop
profiles into setpoints, drives the controllers' REST APIs, and fans telemetry out to the dashboard
over WebSockets ([P2 architecture](../specs/design/platform/02-spec-platform-architecture.md),
[deployment](../specs/design/platform/08-spec-platform-operations.md#2-deployment)).

**Why:** The API's workload is concurrency-heavy — a steady MQTT ingest stream, frequent downward
REST calls to many controllers, and live WebSocket fan-out to dashboard clients. Go's goroutine model
handles that many-connection concurrency cleanly, compiles to a single static binary that
containerizes trivially, and has mature Postgres, MQTT, and HTTP/WebSocket libraries. Echo is a
lightweight router/middleware layer over `net/http` with first-class WebSocket-upgrade support, which
is what the API surface ([P2 API surface](../specs/design/platform/09-spec-platform-interfaces.md#3-api-surface-inventory)) needs
without a heavier framework.

**Alternatives considered:** *Node.js / TypeScript* — strong async I/O and shares a language with the
React frontend, but single-threaded execution is a weaker fit for the CPU-touching ingestion path.
*Python* — would unify with Phase 3, but the GIL and interpreter speed are a poorer match for the
sustained-concurrency hub. *Rust* — excellent performance (and Phase 1's choice), but slower
development velocity for what is largely a CRUD-plus-ingestion service. *Other Go routers (gin, chi,
stdlib `net/http`)* — all viable; Echo chosen for its batteries-included middleware and WebSocket
ergonomics, and the abstraction is thin enough to swap.

**Tradeoffs accepted:** Go's error-handling verbosity and historically lean generics, and a dependency
on a third-party framework (Echo) over the standard library. Accepted: the concurrency fit and
operational simplicity (one static binary) dominate for this service, and Echo stays close to
`net/http`.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-01 — Phase 1 async runtime: Tokio

**Decision:** Run the Rust controller on the **Tokio** async runtime. Tokio drives the controller's
concurrent I/O surfaces — MQTT telemetry publishing and the REST config/override server
([P1 §11](../specs/design/controller/08-spec-controller-interfaces.md)) — around the fixed-tick control
loop ([P1 §2](../specs/design/controller/02-spec-controller-architecture.md#2-the-tick-pipeline)).

**Why:** The controller services several concurrent I/O channels alongside its periodic control tick,
and Tokio is the de-facto async runtime in the Rust ecosystem — the mature MQTT and HTTP crates are
built on it. Async I/O keeps those channels non-blocking without a thread per connection, and the
control loop runs as a scheduled interval task. Timing predictability for the tick comes from
Rust's no-GC execution plus a dedicated timer ([see the Rust
entry](#2026-06-01--phase-1-controller-language-rust)); Tokio handles the surrounding I/O concurrency.

**Alternatives considered:** *`std` threads + blocking I/O* — no async dependency, but a thread per
connection and manual coordination across the MQTT/REST surfaces. *`async-std`* — comparable model,
but a smaller and less actively maintained ecosystem than Tokio. *`smol`* — lightweight, but the
controller's I/O crates assume Tokio.

**Tradeoffs accepted:** async Rust adds real complexity (`Send`/`Sync` bounds and `.await` coloring),
and Tokio is a sizable dependency. Accepted because it is the ecosystem standard the I/O libraries
target, and the alternative is hand-managing concurrency for several long-lived connections.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.

---

## 2026-06-01 — Phase 1 controller language: Rust

**Decision:** Implement the Phase 1 controller in **Rust** — the deterministic, real-time control
loop that reads simulated sensors, runs the control hierarchy against setpoints, enforces safety
interlocks, and drives simulated actuators behind the HAL
([P1 §1](../specs/design/controller/01-spec-controller-overview.md#1-what-the-controller-is),
[§2](../specs/design/controller/02-spec-controller-architecture.md#2-the-tick-pipeline)).

**Why:** The controller is a fixed-tick real-time loop where timing predictability and correctness
matter most. Rust has no garbage collector, so there are no GC pauses to perturb the tick; its
ownership model gives memory safety without a runtime; and its trait system expresses the HAL
actuator interface cleanly — including the forward-looking constraint that an actuator produces a
*set* of effects on climate variables rather than a one-to-one mapping
([P1 §3](../specs/design/controller/03-spec-controller-hal-simulation.md),
[RFC-006](./request-for-comments.md#rfc-006-phase-4-seam-strategy)). It compiles to a small static
binary, so each greenhouse runs as a lightweight container
([P1 §13](../specs/design/controller/02-spec-controller-architecture.md#8-deployment)).

**Alternatives considered:** *C / C++* — comparable real-time determinism and control over timing,
but manual memory management reintroduces the safety class Rust eliminates at compile time. *Go* — fast
to develop and the platform's choice, but its garbage collector can introduce pauses that undermine a
deterministic control tick. *Python* — fastest to prototype, but interpreter speed and the GIL make it
unsuitable for a tight real-time loop.

**Tradeoffs accepted:** a steeper learning curve, longer compile times, and borrow-checker friction;
and because the HAL is pure simulation, some of Rust's bare-metal/embedded advantages go unused here.
Accepted because the deterministic-timing and memory-safety guarantees, plus the typed
actuator-effects trait that keeps the Phase 4 seam additive, are worth it for the system's
safety-critical layer. The opposite call is made for the
[Phase 3 optimizer (Python)](#2026-06-05--phase-3-optimizer-language-python), whose constraints are
the reverse.

**Basis:** Foundational tech-stack choice — predates the RFC process; no RFC.
