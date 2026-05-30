# Physical System — Multi-Greenhouse Site

## The Site

A **site** (sometimes called a *range*) is a collection of multiple independent greenhouse
structures at a single physical location, run as one operation. Each greenhouse is a self-contained
climate enclosure with its own sensors and its own actuators, controlled independently of the others.
The greenhouses sit side by side and share a postal address, but each one manages its own climate in
isolation.

The **site** is the unit the Phase 2 platform manages; the **individual greenhouse** is the unit a
Phase 1 controller controls. This document describes the world *above* a single greenhouse — the
site. For the physical system *inside* one greenhouse (the sensors, actuators, and their coupling),
see [`physical-system-single.md`](./physical-system-single.md).

> Each greenhouse at the site is one instance of the physical system described in
> [`physical-system-single.md`](./physical-system-single.md), with its own complete inventory of sensors and
> actuators and its own controller. There is no shared air mass, shared sensing, or shared actuation
> between greenhouses.

---

## Site Topology

A typical simulated site:

| Element | Description |
| --- | --- |
| Greenhouses (×N) | Independent enclosed structures, each its own climate domain |
| Controllers (×N) | One per greenhouse; each greenhouse is controlled on its own |
| Site identity | A logical grouping of greenhouses run as one operation |
| Location | All greenhouses share one geographic location (same latitude, same daylight, same weather in reality) |

The greenhouses are **homogeneous in capability** but **heterogeneous in configuration**: every
greenhouse has the same kind of sensors and actuators, but each grows a different crop, in a different
number of irrigation [zones](./physical-system-single.md#zones), held at the conditions that crop
needs. That heterogeneity is precisely what makes a *management* platform worthwhile — an operator
overseeing a tomato house, a lettuce house, and a propagation house needs one place to oversee them
all.

---

## Each Greenhouse Is Independent

Within the simulation, greenhouses do not physically interact:

- **Own sensors** — each greenhouse has its own redundant temperature probes, humidity, CO₂, PAR,
  and per-zone soil moisture sensors. Readings from one greenhouse say nothing about another.
- **Own actuators** — each greenhouse has its own heater, fans, roof vents, misters, CO₂ injector,
  grow lights, shade screen, and per-zone irrigation valves.
- **Controlled independently** — each greenhouse is regulated on its own; how one house is run has no
  bearing on another (the per-greenhouse control software is described in
  [`physical-system-single.md`](./physical-system-single.md) and the P1 spec).
- **No inter-greenhouse coupling** — opening vents in greenhouse A does not affect greenhouse B.
  Adjacent structures do not exchange heat, humidity, or CO₂.
- **Independent failure domains** — because nothing physical is shared between greenhouses, a problem
  in one (a failed sensor, a stuck actuator, a damaged structure) cannot reach another through the
  environment. A site-wide event would have to arrive through shared infrastructure, which is out of
  scope (below).

---

## Common Inputs — Out of Scope

A real multi-greenhouse site shares physical infrastructure across all of its houses. **None of
this shared layer is modeled.** Each greenhouse is simulated as if it has unlimited, independent
access to its own resources — there is no resource contention, no shared-supply failure, and no
site-wide depletion.

| Shared input (real site) | Why it's out of scope |
| --- | --- |
| Water supply / reservoir | Each greenhouse irrigates from an assumed-infinite source; no shared tank or contention |
| Electrical supply | No site power budget, brownout, or load-shedding across greenhouses |
| Fuel / bulk CO₂ supply | Each CO₂ injector draws from its own assumed-infinite supply; no shared tank depletion |
| Central heating plant (boiler) | Real sites often pipe heat from one boiler; we model a per-greenhouse heater instead |
| Site weather station | No shared outdoor-sensor feed; see below |
| Network / connectivity | No modeled site network, gateway, or its failure modes |

Modeling shared supply (and the contention and failure modes it introduces) would be a site-level
physics concern — a natural fit for the Phase 3 simulation layer, not Phase 1 or 2.

---

## Site Environment

In reality every greenhouse at one site is under the same sky — same outdoor temperature, same solar
cycle, same wind. In the simulation, the outdoor conditions that drive each greenhouse's load are
part of each controller's **own** [hidden disturbance model](./physical-system-single.md#hidden-disturbance-model),
configured per greenhouse. There is **no shared site weather source**.

Two consequences:

- To represent "the same site," the greenhouses' disturbance profiles can be configured identically
  (same outdoor-temperature curve, same daylight profile) — but this is a configuration choice, not
  an enforced physical link.
- A single authoritative site weather model feeding all greenhouses would be a shared-input feature,
  and like the other common inputs above, it is out of scope here (Phase 3 territory).

---

## Weather Forecast

The [outdoor conditions](#site-environment) a site faces are not static — they rise and fall through
the day and across seasons. A **weather forecast** is a real, readily available prediction of where
those conditions are heading over the coming hours and days: the temperature, sunshine, wind, and
humidity the site will be exposed to. Because every greenhouse shares one sky, a single forecast
describes the upcoming outdoor environment for the whole site at once.

A forecast is, in effect, advance notice of the disturbance the greenhouses will have to fight — a
cold night to be held off, a sunny afternoon's heat to be shed, a humid front rolling in. It is
information about the *future* of the outdoor environment, as opposed to the live outdoor conditions
the greenhouses already contend with today.

## Crop

Each greenhouse physically contains a **crop** — the plants actually growing inside it. The crop is
the reason the climate is controlled at all; it is what the whole system ultimately serves. A lettuce
house, a tomato house, and a tray of propagating seedlings are physically different in what they hold,
even when their sensors and actuators are identical.

A **crop profile** is the set of climate conditions a given crop prefers — its comfortable temperature
range, [vapor pressure deficit (VPD)](./physical-system-single.md#derived-value-vpd), daily light
integral (DLI), and CO₂ concentration. These differ from crop to crop, and they shift as a crop moves
through its growth stages (propagation, vegetative, fruiting). The crop's identity is therefore a real
physical attribute of a greenhouse, not merely a setting: it is what determines the climate that house
should be held at.

This is the source of the site being
[homogeneous in capability but heterogeneous in configuration](#site-topology): identical hardware
across the houses, but a different crop — and so a different ideal climate — growing in each.

---

## Out of Scope for this Site Model

Beyond the common inputs already listed, the following site-level concerns are **not** modeled:

**Inter-greenhouse physical coupling** — shared walls, connecting corridors, or air exchange between
adjacent structures. Each greenhouse is treated as thermally and atmospherically isolated.

**Site geometry & layout** — the spatial arrangement of greenhouses, distances, orientation, and
shading of one structure by another. Greenhouses are an unordered set, not a map.

**Shared service buildings** — head house, packing areas, central control rooms, and other
non-growing structures are not represented.

**Site-wide orchestration** — coordinated behavior across greenhouses (e.g., staggering loads to
respect a shared power budget) requires the shared-infrastructure model that is out of scope. Phase 2
*aggregates and manages* greenhouses; it does not couple their physics.
