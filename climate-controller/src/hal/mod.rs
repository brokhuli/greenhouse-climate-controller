//! The Hardware Abstraction Layer — the only I/O seam the pipeline touches ([architecture §1]).
//!
//! The pipeline reads sensors and commands actuators **through the [`Hal`] trait**, never against
//! the simulator behind it. Swapping the simulated backend for real hardware — or the Phase 4
//! combustion heater — is a new trait impl, not a control-logic rewrite (`P1-MOD-1`). The
//! simulated backend additionally implements [`SimControl`] (sensor-reading injection, actuator
//! fault injection, time-scale) — a simulation-only surface a real backend does not provide
//! ([HAL §8], [HAL §9]).

pub mod sim;

pub use sim::SimulatedHal;

use std::collections::BTreeMap;

use crate::clock::Clock;
use crate::domain::{Actuator, Slug};

/// The seven house-level actuators, in a fixed canonical order for deterministic iteration.
pub const HOUSE_ACTUATORS: [Actuator; 7] = [
    Actuator::Heater,
    Actuator::Fans,
    Actuator::RoofVents,
    Actuator::Misters,
    Actuator::Co2Injector,
    Actuator::GrowLights,
    Actuator::ShadeScreen,
];

/// Raw sensor readings straight off the HAL, before any [fusion or fault detection](../sensing).
/// Temperature is a *slice* of redundant probes; everything else is a single channel (per-zone
/// for soil moisture).
#[derive(Debug, Clone, PartialEq)]
pub struct RawReadings {
    /// Redundant air-temperature probes (°C). Length is the configured probe count (TMR default 3).
    pub temperature_probes: Vec<f64>,
    /// Relative humidity (%RH).
    pub humidity_pct: f64,
    /// CO₂ concentration (ppm).
    pub co2_ppm: f64,
    /// Photosynthetically active radiation (µmol·m⁻²·s⁻¹).
    pub par: f64,
    /// Per-zone soil moisture (VWC), keyed by zone id.
    pub soil_moisture: BTreeMap<Slug, f64>,
}

/// An addressable actuator: a house-level device or a specific zone's irrigation valve. Used as a
/// map key everywhere the pipeline needs to address actuators uniformly (override, health,
/// constraints).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ActuatorId {
    /// A house-level actuator (one of [`HOUSE_ACTUATORS`]).
    House(Actuator),
    /// A per-zone irrigation valve.
    Valve(Slug),
}

/// Actuator command levels, `0.0..=100.0` (% for modulating actuators; 0 / 100 for on/off).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Commands {
    /// House-level actuator levels, keyed by actuator.
    pub house: BTreeMap<Actuator, f64>,
    /// Per-zone valve levels, keyed by zone id.
    pub valves: BTreeMap<Slug, f64>,
}

impl Commands {
    /// All-off commands for a greenhouse with the given zones.
    pub fn all_off(zone_ids: &[Slug]) -> Self {
        let house = HOUSE_ACTUATORS.iter().map(|&a| (a, 0.0)).collect();
        let valves = zone_ids.iter().map(|z| (z.clone(), 0.0)).collect();
        Commands { house, valves }
    }

    /// The level commanded for `id` (0 if unknown).
    pub fn get(&self, id: &ActuatorId) -> f64 {
        match id {
            ActuatorId::House(a) => self.house.get(a).copied().unwrap_or(0.0),
            ActuatorId::Valve(z) => self.valves.get(z).copied().unwrap_or(0.0),
        }
    }

    /// Set the level for `id`, clamped to `0..=100`.
    pub fn set(&mut self, id: &ActuatorId, level: f64) {
        let level = level.clamp(0.0, 100.0);
        match id {
            ActuatorId::House(a) => {
                self.house.insert(*a, level);
            }
            ActuatorId::Valve(z) => {
                self.valves.insert(z.clone(), level);
            }
        }
    }

    /// Every actuator id in canonical order (house actuators, then zone valves by id).
    pub fn ids(&self) -> Vec<ActuatorId> {
        let mut ids: Vec<ActuatorId> = self.house.keys().map(|&a| ActuatorId::House(a)).collect();
        ids.extend(self.valves.keys().map(|z| ActuatorId::Valve(z.clone())));
        ids
    }
}

/// Observed actuator readback — what the actuator is *actually* doing, which can diverge from the
/// command when an actuator is stuck/jammed ([HAL §8]). Same shape as [`Commands`]; the
/// [actuator-health monitor](../safety) compares the two.
pub type Observed = Commands;

/// A raw sensor channel that can be force-injected on the simulated backend ([HAL §9]).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SensorChannel {
    /// One temperature probe (index into the probe slice).
    TemperatureProbe(usize),
    /// The humidity sensor.
    Humidity,
    /// The CO₂ sensor.
    Co2,
    /// The PAR sensor.
    Par,
    /// A zone's soil-moisture sensor.
    SoilMoisture(Slug),
}

/// An injectable actuator fault ([HAL §8]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActuatorFaultKind {
    /// Observed freezes on; ignores commands; effect follows the frozen state.
    StuckOn,
    /// Observed freezes off; ignores commands; effect follows the frozen state.
    StuckOff,
    /// Observed tracks the command, but the actuator's climate effect is suppressed.
    NoEffect,
}

/// The hardware seam: read sensors, command actuators, read back observed actuator state, and
/// (on a simulated backend) advance the modeled plant by one tick. A real-hardware backend would
/// implement `read`/`command`/`observed` against devices and make `step` a no-op.
pub trait Hal {
    /// Current raw sensor readings (reflect the previous tick's commands after lag).
    fn read(&self) -> RawReadings;
    /// Latch the commanded actuator levels for this tick.
    fn command(&mut self, commands: &Commands);
    /// Observed actuator readback (reflects the previous tick's commands after device dynamics).
    fn observed(&self) -> Observed;
    /// Advance the modeled plant by one `Δt` using the latched commands (simulated backend only).
    fn step(&mut self, clock: &Clock);
}

/// Simulation-only control surface implemented by the simulated backend ([HAL §8], [HAL §9]).
/// A real-hardware backend does not implement it; the deferred REST surface that drives it returns
/// 404 there.
pub trait SimControl {
    /// Force a sensor channel to `value` for `ttl_ticks` (or the configured default TTL).
    fn inject_sensor(&mut self, channel: SensorChannel, value: f64, ttl_ticks: Option<u64>);
    /// Clear a sensor injection.
    fn clear_sensor_injection(&mut self, channel: &SensorChannel);
    /// Inject an actuator fault for `ttl_ticks` (or the configured default TTL).
    fn inject_actuator_fault(
        &mut self,
        id: ActuatorId,
        kind: ActuatorFaultKind,
        ttl_ticks: Option<u64>,
    );
    /// Clear an actuator fault.
    fn clear_actuator_fault(&mut self, id: &ActuatorId);
    /// Set the wall-clock tick-cadence multiplier (used by the deferred scheduler; stored here).
    fn set_time_scale(&mut self, scale: f64);
    /// The current time-scale.
    fn time_scale(&self) -> f64;
}
