# Platform — Crop Profiles, Reconciliation & Fleet Control

> **Purpose:** Define the platform's **defining responsibility** — turning a crop and
> its growth stage into the controller's numeric setpoints, keeping the controller
> faithful to them (reconciliation), and giving the operator a single surface to act
> on any greenhouse. This is the **control-down** half of the platform's bidirectional
> model ([ingestion](./04-spec-platform-ingestion.md) is the up half). Setpoint authority
> and the delivery chain are fixed by
> [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).

> **Phase 2b.** Sections [§1](#1-profiles-and-assignment)–[§4](#4-boundary-with-phase-3--single-setpoint-authority)
> (profiles, resolution, reconciliation) are **2b**. In 2a the only downward write is
> the ad-hoc setpoint relay in [§5](#5-fleet-management--operator-control); the
> controller otherwise regulates to its own TOML setpoints. Within §5, registration,
> status aggregation, and the relay are **2a**; the **sticky / reconciled** behavior
> of an edit is **2b**.

A controller is [crop-agnostic](../controller/07-spec-controller-config-and-parameters.md)
— it regulates to whatever numbers it is given. The platform owns the layer above:
turning a crop (and its growth stage) into those numbers, and keeping the controller
faithful to them.

---

## 1. Profiles and assignment

- A **crop profile** is a named, stage-aware bundle of targets — e.g. *lettuce /
  vegetative* → its temperature day/night, VPD target (with humidity safety bounds), DLI, and CO₂ targets,
  **plus** the per-zone soil-moisture thresholds and watering schedule that crop
  wants. Profiles form a small library, editable in the dashboard
  ([data model](./03-spec-platform-data-model.md)).
- A greenhouse has exactly **one active assignment** at a time: a profile + the
  current growth stage. Advancing the stage (propagation → vegetative → fruiting)
  re-selects the stage's target bundle.

---

## 2. Resolution and the write path

Applying an assignment **resolves** the profile's target bundle into the controller's
setpoints and pushes them down via the controller's REST config API — the runtime
`PATCH` path described in
[controller config](../controller/07-spec-controller-config-and-parameters.md). Because
the target bundle mirrors the controller's `[setpoints]` schema
([data model](./03-spec-platform-data-model.md)), resolution is a direct mapping.

---

## 3. Reconciliation — the platform is the source of truth

The platform does not fire-and-forget. It holds an **intended state** for each
greenhouse — the resolved profile **plus** any sticky operator setpoint edits layered
on top ([§5](#5-fleet-management--operator-control)) — and continuously keeps the live
controller matching it:

- **Apply on change** — assigning a profile or editing its targets pushes the new
  setpoints down.
- **Re-assert on reconnect** — when a controller comes back online
  ([ingestion](./04-spec-platform-ingestion.md#4-qos-retained--liveness)), the platform
  re-pushes the intended setpoints so a restarted controller cannot silently revert to
  its local TOML defaults. If a controller is **offline** when its intended state
  changes, the change is held and applied on reconnect rather than lost.
- **Drift detection** — the platform compares the controller's reported setpoints
  (from telemetry / its REST status) against the intended state. A mismatch is
  surfaced as **drift** in the fleet view and may be auto-corrected by re-applying.
  This catches out-of-band local edits.

Under stress these behaviors are **damped** so they converge rather than storm — the
reconciliation analogue of the controller's bounded-buffer discipline
([controller interfaces §7](../controller/08-spec-controller-interfaces.md#7-mqtt-connection-resilience)):

- **Re-assert is idempotent.** The controller's REST `PATCH` is a merge latched to the
  next tick ([controller config](../controller/07-spec-controller-config-and-parameters.md)),
  so a repeated re-assert simply re-converges — correctness never depends on a write
  landing exactly once, only on the last one landing.
- **Fleet re-assert is staggered.** When many controllers reconnect at once after a
  shared outage (a platform or broker restart), re-asserts are spread with **jittered
  backoff** rather than fired simultaneously, so the controllers' REST APIs are not
  thundering-herded. Staggering stays within `P2-REL-1` — each greenhouse is still
  re-asserted within one reconciliation cycle of its own reconnect.
- **Drift auto-correction is rate-limited.** Auto-re-apply backs off on repeated
  failure and does not tight-loop against a persistent out-of-band local edit; drift
  that keeps recurring is **surfaced in the fleet view** rather than fought
  indefinitely, leaving the operator to resolve the conflict.

---

## 4. Boundary with Phase 3 — single setpoint authority

The platform owns the **static** mapping — "this crop, this stage → these targets."
Phase 3 later **refines** those targets dynamically (anticipatory, cost-aware) within
crop-safe bounds; that optimization is out of scope here
([constraints](./11-spec-platform-constraints.md)).

Crucially, the optimizer is **not** a second setpoint authority. The platform is the
**single authority for controller setpoints**
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
when Phase 3 lands, the optimizer submits refined targets through this same setpoint
write path (a setpoint-submission endpoint, [API surface](./09-spec-platform-interfaces.md#3-api-surface-inventory)),
and the platform enforces the crop-safe bounds, records the write with its source
(`optimizer`), and remains the sole delivery path to the controller — exactly as it
does for a crop-profile assignment or an operator setpoint edit. The optimizer never writes
to a controller directly.

---

## 5. Fleet management & operator control

Beyond profiles, the platform is the operator's single pane of glass for acting on any
greenhouse. Registration, status aggregation, and the ad-hoc setpoint relay are **2a**;
the **sticky / reconciled** behavior of an edit depends on the intended-state machinery
above and so lands in **2b**.

- **Device registry** *(2a)* — greenhouses and their controller endpoints are
  **registered manually** via the API/dashboard (the platform does not auto-discover
  controllers); this registry is the bootstrap that ingestion and resolution key off.
  The controller-endpoint record also carries an **optional per-controller bearer token**
  ([RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)):
  when a controller is configured to require it
  ([controller interfaces §3](../controller/08-spec-controller-interfaces.md#authenticating-the-write-path-optional)),
  the platform stores the matching token here and presents it on every downward REST call; by default
  the field is empty and downward calls are untokened (the single-host local posture). It is a
  credential, not control data — it does not touch the setpoint-only contract.
  Greenhouses can also be **retired**; on retire the platform **clears the greenhouse's
  retained `gh/{greenhouse_id}/state`** by publishing a zero-length retained message, so
  no ghost snapshot lingers in the broker to be replayed to every new subscriber on
  connect ([ingestion §4](./04-spec-platform-ingestion.md#4-qos-retained--liveness)).
  This is **broker-state housekeeping on the retained snapshot**, tied to registry
  lifecycle — not a control write and not ingestion. It does not breach the
  setpoint-only / telemetry-only contract
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
  [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)):
  it targets the broker's retained state, not the departing controller, which subscribes
  to nothing.
- **Status aggregation** *(2a; drift in 2b)* — per-greenhouse online/degraded status
  (from [ingestion](./04-spec-platform-ingestion.md#4-qos-retained--liveness)) rolled up
  into a site-wide fleet view; the **drift** dimension arrives with reconciliation
  ([§3](#3-reconciliation--the-platform-is-the-source-of-truth), 2b).
- **Ad-hoc setpoint edits** *(2a relay; sticky/reconciled in 2b)* — the operator's
  manual control surface: a one-off setpoint change relayed to the controller's REST
  config API. In 2a this is a direct relay. Once the platform is the source of truth
  (2b), such an edit becomes a **sticky** part of the greenhouse's intended state
  (layered over the profile, flagged as deliberate drift) so reconciliation does not
  immediately revert it, and it follows the same offline handling as profile
  resolution — held and re-asserted on reconnect
  ([§3](#3-reconciliation--the-platform-is-the-source-of-truth)). The platform's
  downward control is **setpoint-only**; it does not force individual actuators
  ([constraints](./11-spec-platform-constraints.md)).
- **Change attribution** — every downward write (profile application, ad-hoc setpoint
  edit) is recorded as an event with who/what/when, for audit and for the dashboard's
  activity view.

> **Safety stays in the controller.** The platform only ever sets *targets* (profile
> or ad-hoc setpoints) — it never commands actuators directly, so it has no imperative
> path that could drive an unsafe state. The controller's critical-temp and CO₂-ceiling
> [interlocks](../controller/06-spec-controller-safety-and-constraints.md#2-safety-interlocks)
> keep unconditional priority **inside the controller** and bound actual actuation
> regardless of which setpoints the platform pushes. The platform observes and reports
> interlock activations; it never overrides them.

---

## 6. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Where profiles, assignments, and intended state are stored | reads/writes | [`03-spec-platform-data-model.md`](./03-spec-platform-data-model.md) |
| The status / liveness reconciliation reacts to | consumes | [`04-spec-platform-ingestion.md`](./04-spec-platform-ingestion.md) |
| The REST endpoints that expose profiles, assignments, setpoints | exposed by | [`09-spec-platform-interfaces.md`](./09-spec-platform-interfaces.md#3-api-surface-inventory) |
| The controller config API setpoints are pushed to | writes to | [controller config](../controller/07-spec-controller-config-and-parameters.md), [controller interfaces](../controller/08-spec-controller-interfaces.md) |
| Setpoint authority + delivery chain | defers to | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| Why safety is not the platform's to own | defers to | [`11-spec-platform-constraints.md`](./11-spec-platform-constraints.md) |
