# Physical System — Greenhouse Climate Controller

## The Physical System

A greenhouse is a sealed or semi-sealed enclosure — glass or polycarbonate — where every
environmental variable affecting plant growth can be measured and adjusted. Unlike outdoor farming,
the enclosure gives you meaningful control over temperature, humidity, CO₂, light, and water. The
tradeoff is that you are now responsible for maintaining all of them.

The variables are **coupled**: opening vents to cool the space also flushes CO₂ and drops
humidity. Running misters to raise humidity also cools the air. Heating raises temperature but
drives down relative humidity. A greenhouse controller must manage these interactions, not treat
each variable independently.

In this project, the physical hardware is replaced by a **HAL (Hardware Abstraction Layer)** that
simulates sensors and actuators in software. The control logic is real; the hardware is not.

> This document describes the **physical system** — the world being controlled. For how the Phase 1
> controller senses, decides, and acts on it (control loops, sensor fusion, configuration, fault
> handling), see [`spec-climate-controller.md`](./spec-climate-controller.md).

---

## Inputs — Sensors

### Climate Sensors

| Sensor                      | Measures                                        | Notes                                                                   |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| Temperature (×3, redundant) | Air temperature (°C)                            | Core input; instrumented with three co-located probes for fault tolerance (fusion algorithm in the P1 spec) |
| Humidity                    | Relative humidity (% RH)                        | Combined with fused temperature to compute VPD                          |
| CO₂                         | Concentration (ppm)                             | Drives CO₂ injector; interlocked with vent position                     |
| PAR                         | Photosynthetically active radiation (µmol/m²/s) | Required for grow light and shade screen control                        |

### Root Zone / Irrigation Sensors

| Sensor                   | Measures                       | Notes                                             |
| ------------------------ | ------------------------------ | ------------------------------------------------- |
| Soil moisture (per zone) | Volumetric water content (VWC) | Capacitance-based; one sensor per irrigation zone |

### Zones

A **zone** is a named irrigation region with its own soil moisture sensor and irrigation valve.
Zone count and layout are arbitrary — they depend on the greenhouse layout (e.g., separate benches,
growing trays, propagation areas). Each zone is watered independently of the others.

> How zones are configured and scheduled in the controller is covered in the P1 spec.

### Derived Value: VPD

Vapor Pressure Deficit (kPa) is computed from the fused temperature and RH — it is not a sensor
but a calculated input used as the true control target for the thermal and humidity loops.

VPD describes the "dryness" of the air from the plant's perspective:
- **Too high** (hot, dry air): plant transpires faster than roots supply water; stomata close;
  photosynthesis stops
- **Too low** (cool, humid air): transpiration stalls; nutrient uptake stops; tip burn in
  fast-growing crops
- **Target range**: 0.8–1.2 kPa for most crops

---

## Outputs — Actuators

### Thermal

| Actuator          | Type                                  | Effect                                               |
| ----------------- | ------------------------------------- | ---------------------------------------------------- |
| Heater            | On/off or modulating                  | Raises air temperature                               |
| Ventilation fans  | Variable speed                        | Exhausts hot/humid air; cools by air exchange        |
| Roof vents        | Motorized, variable position (0–100%) | Passive thermal relief via convection; CO₂ interlock |
| Misters / foggers | On/off solenoid                       | Raises humidity; cools air via evaporation           |

### CO₂

| Actuator     | Type            | Effect                                                 |
| ------------ | --------------- | ------------------------------------------------------ |
| CO₂ injector | On/off solenoid | Raises CO₂ concentration; disabled when vents are open |

### Lighting

| Actuator     | Type                  | Effect                                                         |
| ------------ | --------------------- | -------------------------------------------------------------- |
| Grow lights  | On/off or dimmable    | Supplemental PAR when natural light is insufficient            |
| Shade screen | Motorized retractable | Reduces solar heat load; only useful if PAR sensor is included |

### Irrigation

| Actuator          | Type                          | Effect                      |
| ----------------- | ----------------------------- | --------------------------- |
| Irrigation valves | On/off solenoid, one per zone | Delivers water to root zone |

---

## The Coupling Problem

The central challenge of greenhouse control is that actuators affect multiple variables
simultaneously:

- **Opening vents** → lowers temperature, lowers CO₂, lowers humidity
- **Running misters** → raises humidity, lowers temperature
- **CO₂ via combustion burner** → raises CO₂, raises temperature, raises humidity
- **Heating** → raises temperature, lowers RH (same absolute moisture, lower relative)

A naive controller that chases each variable independently will fight itself — for example,
opening vents to cool the space while the CO₂ injector tries to enrich. Any controller for this
system must account for the coupling explicitly. This is a property of the physical system, not of
any particular controller; how the Phase 1 controller models and handles it is covered in the P1
spec.

---

## Out of Scope for this Physical Model

These are parts of a real greenhouse that this project does **not** instrument or model. (Controller
*capabilities* that are deferred — predictive control, energy optimization, advanced sensor fusion —
are listed in the P1 spec's scope section, not here.)

**Greenhouse dimensions & geometry** — no volumetric or spatial model. Physical size affects
hardware sizing (heater output, fan airflow) in reality, but this project does not model the volume
or layout. Becomes relevant in **Phase 3**, whose simulation engine models heat/humidity/CO₂
dynamics using greenhouse volume.

**Crop-specific physiology / plant species** — this is a generic greenhouse, not a crop model. Real
crops differ in transpiration, CO₂ uptake, and light response; those differences surface only as
different setpoint *values*, not different physics. Plant-specific dynamics belong to **Phase 3**.

**Nutrient subsystem hardware** — EC/pH sensors and dosing pumps are not instrumented. Nutrient
management is a parallel control discipline, orthogonal to climate control.

**Weather / outdoor instrumentation** — no outdoor-temperature, wind, or rain sensors. The system
senses only indoor conditions. Weather-reactive behavior belongs to **Phase 3**'s predictive layer.

**Other physical elements not modeled** — root-zone temperature, evaporative cooling pads, and
spatial multi-zone temperature gradients. (Note: the three *co-located* redundant temperature
probes are instrumented and in scope — that is fault-tolerant sensing of a single location, which
is distinct from sensing a spatial gradient across multiple locations.)
