//! The simulated HAL backend ([HAL §2–§9]).
//!
//! A **coupled first-order-lag** model — `x += (Δt/τ)·(x_target − x)` — not a heat/mass balance
//! ([HAL §6]). Each actuator contributes a *set* of effects to its variables' targets via the
//! config coupling matrix ([HAL §3–§4]); hidden disturbances (outdoor temperature + conduction,
//! a solar day-cycle, plant CO₂ uptake, soil drying) supply the load the controller fights
//! ([HAL §5]). Everything is deterministic under the configured seed ([HAL §7]): sensor noise is
//! the only stochastic element and it draws from the seeded [`Rng`]. The backend also synthesizes
//! the observed actuator readback and implements [`SimControl`] for sensor/actuator fault
//! injection.

use std::collections::{BTreeMap, HashMap};

use crate::clock::{Clock, DT_SECS};
use crate::config::{Config, Disturbances, Noise, Solar, TimeConstants};
use crate::domain::{Actuator, ClimateVariable, Slug};
use crate::rng::Rng;

use super::{
    ActuatorFaultKind, ActuatorId, Commands, HOUSE_ACTUATORS, Hal, Observed, RawReadings,
    SensorChannel, SimControl,
};

/// Outdoor CO₂ concentration the greenhouse equilibrates toward when unventilated/un-enriched (ppm).
const CO2_AMBIENT_PPM: f64 = 420.0;

/// An active sensor-reading injection: a forced value with a remaining lifetime in ticks.
#[derive(Debug, Clone)]
struct SensorInjection {
    value: f64,
    remaining: u64,
}

/// An active actuator fault with a remaining lifetime in ticks.
#[derive(Debug, Clone)]
struct ActuatorFault {
    kind: ActuatorFaultKind,
    remaining: u64,
}

/// The simulated plant + actuators behind the [`Hal`] trait.
#[derive(Debug, Clone)]
pub struct SimulatedHal {
    // Config-derived (immutable for the run).
    tau: TimeConstants,
    disturbances: Disturbances,
    actuators: Vec<crate::config::ActuatorModel>,
    valve_soil_gain: f64,
    solar: Solar,
    noise: Noise,
    zone_ids: Vec<Slug>,
    probe_count: usize,
    injection_default_ttl: u64,

    // True plant state (never directly observable — only via readings).
    temperature: f64,
    humidity: f64,
    co2: f64,
    par: f64,
    soil: BTreeMap<Slug, f64>,

    // Actuator state.
    commanded: Commands,
    observed: Observed,

    // Precomputed noisy readings for the current tick (injections overlaid live in `read`).
    current_readings: RawReadings,

    // Stochastic + sim-control state.
    rng: Rng,
    time_scale: f64,
    sensor_injections: HashMap<SensorChannel, SensorInjection>,
    actuator_faults: HashMap<ActuatorId, ActuatorFault>,
}

impl SimulatedHal {
    /// Build the simulator from a validated [`Config`].
    pub fn new(config: &Config) -> Self {
        let zone_ids: Vec<Slug> = config.zones.iter().map(|z| z.id.clone()).collect();
        let init = &config.simulation.initial;
        let soil: BTreeMap<Slug, f64> = zone_ids
            .iter()
            .map(|z| (z.clone(), init.soil_moisture))
            .collect();

        // The irrigation valve's soil-moisture coupling gain (one model serves every zone's valve).
        let valve_soil_gain = config
            .hal
            .actuators
            .iter()
            .find(|m| m.actuator == Actuator::IrrigationValve)
            .and_then(|m| {
                m.effects
                    .iter()
                    .find(|e| e.variable == ClimateVariable::SoilMoisture)
                    .map(|e| e.gain)
            })
            .unwrap_or(0.0);

        let mut sim = SimulatedHal {
            tau: config.hal.time_constants.clone(),
            disturbances: config.hal.disturbances.clone(),
            actuators: config.hal.actuators.clone(),
            valve_soil_gain,
            solar: config.simulation.solar.clone(),
            noise: config.simulation.noise.clone(),
            zone_ids: zone_ids.clone(),
            probe_count: config.sensing.probe_count.max(1),
            injection_default_ttl: config.simulation.sensor_injection_timeout_secs,
            temperature: init.temperature_c,
            humidity: init.humidity_pct,
            co2: init.co2_ppm,
            par: 0.0,
            soil,
            commanded: Commands::all_off(&zone_ids),
            observed: Commands::all_off(&zone_ids),
            current_readings: RawReadings {
                temperature_probes: Vec::new(),
                humidity_pct: 0.0,
                co2_ppm: 0.0,
                par: 0.0,
                soil_moisture: BTreeMap::new(),
            },
            rng: Rng::new(config.simulation.seed),
            time_scale: config.simulation.time_scale,
            sensor_injections: HashMap::new(),
            actuator_faults: HashMap::new(),
        };
        sim.current_readings = sim.sample_readings();
        sim
    }

    /// The fraction of peak solar at the current time-of-day — a raised half-sine over the
    /// `[sunrise, sunset)` window, zero at night.
    fn solar_fraction(&self, clock: &Clock) -> f64 {
        let s = f64::from(clock.second_of_day());
        let sr = f64::from(self.solar.sunrise.minutes_since_midnight()) * 60.0;
        let ss = f64::from(self.solar.sunset.minutes_since_midnight()) * 60.0;
        if ss <= sr || s < sr || s >= ss {
            return 0.0;
        }
        let phase = (s - sr) / (ss - sr);
        (std::f64::consts::PI * phase).sin().max(0.0)
    }

    fn is_daytime(&self, clock: &Clock) -> bool {
        clock.is_within(self.solar.sunrise, self.solar.sunset)
    }

    /// Whether an actuator's effect is suppressed (a `NoEffect` fault: it obeys but does nothing).
    fn effect_suppressed(&self, id: &ActuatorId) -> bool {
        matches!(
            self.actuator_faults.get(id).map(|f| f.kind),
            Some(ActuatorFaultKind::NoEffect)
        )
    }

    /// Σ over house actuators of `gain · observed_level/100` for effects on `var`, skipping
    /// effect-suppressed actuators. (Irrigation valves affect only per-zone soil, handled apart.)
    fn house_actuator_sum(&self, var: ClimateVariable) -> f64 {
        let mut sum = 0.0;
        for model in &self.actuators {
            if model.actuator == Actuator::IrrigationValve {
                continue;
            }
            let id = ActuatorId::House(model.actuator);
            if self.effect_suppressed(&id) {
                continue;
            }
            let level = self.observed.get(&id);
            for effect in &model.effects {
                if effect.variable == var {
                    sum += effect.gain * level / 100.0;
                }
            }
        }
        sum
    }

    /// Recompute the observed actuator readback from the commanded levels and any injected faults
    /// ([HAL §8]): a stuck fault freezes observed; otherwise observed tracks the command.
    fn recompute_observed(&mut self) {
        let mut observed = Commands::all_off(&self.zone_ids);
        for &a in &HOUSE_ACTUATORS {
            let id = ActuatorId::House(a);
            observed.set(&id, self.observe_one(&id));
        }
        for z in &self.zone_ids {
            let id = ActuatorId::Valve(z.clone());
            observed.set(&id, self.observe_one(&id));
        }
        self.observed = observed;
    }

    fn observe_one(&self, id: &ActuatorId) -> f64 {
        match self.actuator_faults.get(id).map(|f| f.kind) {
            Some(ActuatorFaultKind::StuckOn) => 100.0,
            Some(ActuatorFaultKind::StuckOff) => 0.0,
            _ => self.commanded.get(id),
        }
    }

    /// Sample the noisy sensor readings from the current true state (no injections — those overlay
    /// live in [`Hal::read`]). Mutates the RNG, so it runs once per tick inside `step`.
    fn sample_readings(&mut self) -> RawReadings {
        // Noisy readings are clamped to physical floors/ceilings — a real sensor never reports
        // negative PAR or >100 %RH from jitter around a boundary. (A forced injection bypasses this
        // in `read`, so the out-of-range detector still sees genuinely implausible injected values.)
        let t = self.temperature;
        let temperature_probes = (0..self.probe_count)
            .map(|_| t + self.rng.next_gaussian() * self.noise.temperature_c)
            .collect();
        let humidity_pct =
            (self.humidity + self.rng.next_gaussian() * self.noise.humidity_pct).clamp(0.0, 100.0);
        let co2_ppm = (self.co2 + self.rng.next_gaussian() * self.noise.co2_ppm).max(0.0);
        let par = (self.par + self.rng.next_gaussian() * self.noise.par).max(0.0);
        let soil_moisture = self
            .zone_ids
            .iter()
            .map(|z| {
                let base = self.soil.get(z).copied().unwrap_or(0.0);
                let noisy = base + self.rng.next_gaussian() * self.noise.soil_moisture;
                (z.clone(), noisy.clamp(0.0, 1.0))
            })
            .collect();
        RawReadings {
            temperature_probes,
            humidity_pct,
            co2_ppm,
            par,
            soil_moisture,
        }
    }

    /// Advance the true plant state by one `Δt` using the observed (post-fault) actuator levels.
    fn integrate(&mut self, clock: &Clock) {
        let dt = DT_SECS as f64;
        let solar = self.solar_fraction(clock);

        // Temperature: first-order lag toward (outdoor + solar gain + actuator effects), plus a
        // small explicit envelope-conduction pull toward bare outdoor (heat_loss_coeff). Each
        // actuator `gain` is its full-on °C contribution to the target.
        let target_t = self.disturbances.outdoor_temp_c
            + self.solar.peak_heat_gain_c * solar
            + self.house_actuator_sum(ClimateVariable::Temperature);
        self.temperature += (dt / self.tau.temperature_s) * (target_t - self.temperature);
        self.temperature += self.disturbances.heat_loss_coeff
            * (self.disturbances.outdoor_temp_c - self.temperature)
            * dt;

        // Humidity: lag toward ambient + actuator effects.
        let target_h = self.disturbances.ambient_humidity_pct
            + self.house_actuator_sum(ClimateVariable::Humidity);
        self.humidity += (dt / self.tau.humidity_s) * (target_h - self.humidity);

        // CO₂: lag toward outdoor ambient + actuator effects, minus plant uptake in daylight.
        let target_c = CO2_AMBIENT_PPM + self.house_actuator_sum(ClimateVariable::Co2);
        self.co2 += (dt / self.tau.co2_s) * (target_c - self.co2);
        if self.is_daytime(clock) {
            self.co2 -= self.disturbances.plant_co2_uptake_ppm_per_s * dt;
        }

        // PAR: lag toward natural solar PAR + actuator effects (lights add, shade subtracts).
        let target_p = self.solar.peak_par * solar + self.house_actuator_sum(ClimateVariable::Par);
        self.par += (dt / self.tau.par_s) * (target_p - self.par);

        // Soil moisture per zone: lag toward the valve's wetting target, minus constant drying.
        let drying = self.disturbances.soil_drying_rate_per_s * dt;
        let tau_soil = self.tau.soil_moisture_s;
        let valve_gain = self.valve_soil_gain;
        let zones = self.zone_ids.clone();
        for z in zones {
            let id = ActuatorId::Valve(z.clone());
            let level = if self.effect_suppressed(&id) {
                0.0
            } else {
                self.observed.get(&id)
            };
            let target_s = valve_gain * level / 100.0;
            if let Some(s) = self.soil.get_mut(&z) {
                *s += (dt / tau_soil) * (target_s - *s) - drying;
                *s = s.clamp(0.0, 1.0);
            }
        }

        // Clamp the house variables to physical plausibility.
        self.temperature = self.temperature.clamp(-50.0, 90.0);
        self.humidity = self.humidity.clamp(0.0, 100.0);
        self.co2 = self.co2.clamp(0.0, 20_000.0);
        self.par = self.par.clamp(0.0, 5_000.0);
    }

    /// Decrement injection / fault lifetimes, dropping any that have expired.
    fn expire(&mut self) {
        self.sensor_injections.retain(|_, inj| {
            inj.remaining = inj.remaining.saturating_sub(1);
            inj.remaining > 0
        });
        self.actuator_faults.retain(|_, f| {
            f.remaining = f.remaining.saturating_sub(1);
            f.remaining > 0
        });
    }
}

impl Hal for SimulatedHal {
    fn read(&self) -> RawReadings {
        // Overlay any active sensor injections on the precomputed noisy readings ([HAL §9]):
        // injections force what the controller *sees* without perturbing the true plant.
        let mut r = self.current_readings.clone();
        for (channel, inj) in &self.sensor_injections {
            match channel {
                SensorChannel::TemperatureProbe(i) => {
                    if let Some(p) = r.temperature_probes.get_mut(*i) {
                        *p = inj.value;
                    }
                }
                SensorChannel::Humidity => r.humidity_pct = inj.value,
                SensorChannel::Co2 => r.co2_ppm = inj.value,
                SensorChannel::Par => r.par = inj.value,
                SensorChannel::SoilMoisture(z) => {
                    if let Some(s) = r.soil_moisture.get_mut(z) {
                        *s = inj.value;
                    }
                }
            }
        }
        r
    }

    fn command(&mut self, commands: &Commands) {
        // Clamp incoming levels through `set` so stored state is always well-formed.
        let mut clamped = Commands::all_off(&self.zone_ids);
        for id in commands.ids() {
            clamped.set(&id, commands.get(&id));
        }
        self.commanded = clamped;
    }

    fn observed(&self) -> Observed {
        self.observed.clone()
    }

    fn step(&mut self, clock: &Clock) {
        self.recompute_observed();
        self.integrate(clock);
        self.current_readings = self.sample_readings();
        self.expire();
    }
}

impl SimControl for SimulatedHal {
    fn inject_sensor(&mut self, channel: SensorChannel, value: f64, ttl_ticks: Option<u64>) {
        let remaining = ttl_ticks.unwrap_or(self.injection_default_ttl).max(1);
        self.sensor_injections
            .insert(channel, SensorInjection { value, remaining });
    }

    fn clear_sensor_injection(&mut self, channel: &SensorChannel) {
        self.sensor_injections.remove(channel);
    }

    fn inject_actuator_fault(
        &mut self,
        id: ActuatorId,
        kind: ActuatorFaultKind,
        ttl_ticks: Option<u64>,
    ) {
        let remaining = ttl_ticks.unwrap_or(self.injection_default_ttl).max(1);
        self.actuator_faults
            .insert(id, ActuatorFault { kind, remaining });
    }

    fn clear_actuator_fault(&mut self, id: &ActuatorId) {
        self.actuator_faults.remove(id);
    }

    fn set_time_scale(&mut self, scale: f64) {
        self.time_scale = scale.clamp(0.25, 8.0);
    }

    fn time_scale(&self) -> f64 {
        self.time_scale
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        );
        Config::load(path).expect("example config loads")
    }

    fn house(level: f64, a: Actuator) -> Commands {
        let cfg = config();
        let zone_ids: Vec<Slug> = cfg.zones.iter().map(|z| z.id.clone()).collect();
        let mut c = Commands::all_off(&zone_ids);
        c.set(&ActuatorId::House(a), level);
        c
    }

    #[test]
    fn determinism_same_seed_same_readings() {
        let cfg = config();
        let mut a = SimulatedHal::new(&cfg);
        let mut b = SimulatedHal::new(&cfg);
        let mut clock = Clock::new();
        let cmd = house(100.0, Actuator::Heater);
        for _ in 0..200 {
            a.command(&cmd);
            b.command(&cmd);
            a.step(&clock);
            b.step(&clock);
            clock.advance();
            assert_eq!(a.read(), b.read());
            assert_eq!(a.observed(), b.observed());
        }
    }

    /// Run a sim for `ticks` driving `cmd` every tick (from midnight), returning the final probe-0
    /// temperature. The plant is pulled toward the cold outdoor ambient, so actuator authority is
    /// only meaningful *relative* to an all-off baseline.
    fn final_temp(cfg: &Config, cmd: &Commands, ticks: usize) -> f64 {
        let mut hal = SimulatedHal::new(cfg);
        let mut clock = Clock::new();
        for _ in 0..ticks {
            hal.command(cmd);
            hal.step(&clock);
            clock.advance();
        }
        hal.read().temperature_probes[0]
    }

    #[test]
    fn heater_raises_temperature_vs_off() {
        let cfg = config();
        let zone_ids: Vec<Slug> = cfg.zones.iter().map(|z| z.id.clone()).collect();
        let off = Commands::all_off(&zone_ids);
        let on = house(100.0, Actuator::Heater);
        assert!(
            final_temp(&cfg, &on, 300) > final_temp(&cfg, &off, 300) + 1.0,
            "heater-on must be warmer than heater-off"
        );
    }

    #[test]
    fn co2_injector_raises_co2() {
        let cfg = config();
        let mut hal = SimulatedHal::new(&cfg);
        let start = hal.read().co2_ppm;
        let cmd = house(100.0, Actuator::Co2Injector);
        let mut clock = Clock::new(); // midnight: no plant uptake
        for _ in 0..200 {
            hal.command(&cmd);
            hal.step(&clock);
            clock.advance();
        }
        assert!(
            hal.read().co2_ppm > start + 50.0,
            "injector should raise CO₂"
        );
    }

    #[test]
    fn sensor_injection_overrides_a_channel() {
        let cfg = config();
        let mut hal = SimulatedHal::new(&cfg);
        hal.inject_sensor(SensorChannel::Co2, 4500.0, Some(10));
        assert_eq!(hal.read().co2_ppm, 4500.0);
        hal.clear_sensor_injection(&SensorChannel::Co2);
        assert_ne!(hal.read().co2_ppm, 4500.0);
    }

    #[test]
    fn single_probe_injection_makes_an_outlier() {
        let cfg = config();
        let mut hal = SimulatedHal::new(&cfg);
        hal.inject_sensor(SensorChannel::TemperatureProbe(0), 99.0, Some(10));
        let r = hal.read();
        assert_eq!(r.temperature_probes[0], 99.0);
        assert_ne!(r.temperature_probes[1], 99.0);
    }

    #[test]
    fn stuck_off_actuator_freezes_observed() {
        let cfg = config();
        let mut hal = SimulatedHal::new(&cfg);
        let id = ActuatorId::House(Actuator::Heater);
        hal.inject_actuator_fault(id.clone(), ActuatorFaultKind::StuckOff, Some(50));
        let cmd = house(100.0, Actuator::Heater);
        let clock = Clock::new();
        hal.command(&cmd);
        hal.step(&clock);
        assert_eq!(hal.observed().get(&id), 0.0, "stuck-off observed stays 0");
    }

    #[test]
    fn no_effect_fault_suppresses_climate_effect() {
        let cfg = config();
        let id = ActuatorId::House(Actuator::Heater);
        let on = house(100.0, Actuator::Heater);

        // A no-effect heater obeys (observed == commanded) but the air behaves as if it were off.
        let mut hal = SimulatedHal::new(&cfg);
        hal.inject_actuator_fault(id.clone(), ActuatorFaultKind::NoEffect, Some(1000));
        let mut clock = Clock::new();
        for _ in 0..300 {
            hal.command(&on);
            hal.step(&clock);
            clock.advance();
        }
        assert_eq!(hal.observed().get(&id), 100.0, "no-effect still obeys");

        let zone_ids: Vec<Slug> = cfg.zones.iter().map(|z| z.id.clone()).collect();
        let off_temp = final_temp(&cfg, &Commands::all_off(&zone_ids), 300);
        assert!(
            (hal.read().temperature_probes[0] - off_temp).abs() < 0.5,
            "no-effect heater must track the heater-off trajectory"
        );
    }
}
