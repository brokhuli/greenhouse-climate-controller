//! Actuator health monitoring — the output-side counterpart to sensor fault detection ([safety §5],
//! `P1-REL-4`).
//!
//! Runs every tick from three inputs: the **previous** tick's commanded levels, this tick's
//! **observed** readback, and this tick's **trusted readings** ([HAL §8]).
//!
//! - **Stuck** — observed diverges from the command beyond a tolerance for a window → disable the
//!   actuator (fail-safe) + `actuator_stuck` alarm.
//! - **No-response** — the actuator obeys but produces no climate effect. Detected here for
//!   irrigation valves (valve commanded open but soil moisture not rising) as the spec's named
//!   `irrigation_no_response` interlock; the zone is disabled + alarm. (General house-actuator
//!   no-response needs masked-effect handling and is left to a later slice.)
//! - **Saturation** is *not* here — it's detected by the loops and never disables ([control-loops]).
//!
//! Flags are sticky only in that the *condition* persists: counters are derived each tick, so an
//! actuator that tracks its command again automatically recovers.

use std::collections::{BTreeMap, BTreeSet};

use crate::config::Config;
use crate::domain::{Actuator, Slug};
use crate::faults::{Fault, FaultType, Severity};
use crate::hal::{ActuatorId, Commands, Observed};
use crate::sensing::TrustedState;

/// Across-tick actuator-health state.
#[derive(Debug, Clone, Default)]
pub struct HealthState {
    stuck_ticks: BTreeMap<ActuatorId, u64>,
    valve_flat_ticks: BTreeMap<Slug, u64>,
    valve_last_soil: BTreeMap<Slug, f64>,
    disabled: BTreeSet<ActuatorId>,
}

impl HealthState {
    /// No faults.
    pub fn new() -> Self {
        HealthState::default()
    }

    /// Update health from the previous command, this tick's observed state, and trusted readings.
    /// Rebuilds the disabled set each tick (so recovery is automatic) and appends any faults.
    pub fn monitor(
        &mut self,
        prev_commanded: Option<&Commands>,
        observed: &Observed,
        trusted: &TrustedState,
        cfg: &Config,
        faults: &mut Vec<Fault>,
    ) {
        self.disabled.clear();
        let Some(prev) = prev_commanded else {
            // No previous command (first tick): nothing to compare yet.
            return;
        };
        let window = cfg.sensing.no_response_window_ticks;
        let tol = cfg.sensing.commanded_vs_observed_tol;

        // Stuck detection across every actuator: observed vs the command we issued last tick.
        for id in observed.ids() {
            let diverged = (observed.get(&id) - prev.get(&id)).abs() > tol;
            let count = self.stuck_ticks.entry(id.clone()).or_insert(0);
            if diverged {
                *count += 1;
            } else {
                *count = 0;
            }
            if *count >= window {
                self.disabled.insert(id.clone());
                faults.push(Fault::new(
                    component_name(&id),
                    FaultType::ActuatorStuck,
                    Severity::Alarm,
                    format!(
                        "{} observed state diverges from command",
                        component_name(&id)
                    ),
                    "disabled the actuator",
                ));
            }
        }

        // No-response detection for irrigation valves: open but soil not rising. This compares the
        // soil reading tick-to-tick, so it assumes the soil signal exceeds sensor noise over the
        // window — true with a low/zero soil-noise σ or a realistically long irrigation window
        // (soil dynamics are slow, τ on the order of minutes).
        for (zone, soil_opt) in &trusted.soil_moisture {
            let id = ActuatorId::Valve(zone.clone());
            let commanded_open = prev.get(&id) > 1.0;
            match soil_opt {
                Some(soil) => {
                    let rose = self
                        .valve_last_soil
                        .get(zone)
                        .map(|last| *soil > last + 1e-6)
                        .unwrap_or(false);
                    self.valve_last_soil.insert(zone.clone(), *soil);
                    let count = self.valve_flat_ticks.entry(zone.clone()).or_insert(0);
                    if commanded_open && !rose {
                        *count += 1;
                    } else {
                        *count = 0;
                    }
                    if *count >= window {
                        self.disabled.insert(id.clone());
                        faults.push(
                            Fault::new(
                                "irrigation_valve",
                                FaultType::IrrigationNoResponse,
                                Severity::Alarm,
                                "valve open but soil moisture not responding",
                                "disabled this zone's irrigation",
                            )
                            .in_zone(zone.clone()),
                        );
                    }
                }
                None => {
                    self.valve_flat_ticks.insert(zone.clone(), 0);
                }
            }
        }
    }

    /// Actuators currently disabled by a health fault. The pipeline forces these off (waiving dwell).
    pub fn disabled(&self) -> &BTreeSet<ActuatorId> {
        &self.disabled
    }
}

/// Component label for a fault, matching the MQTT actuator vocabulary.
fn component_name(id: &ActuatorId) -> &'static str {
    match id {
        ActuatorId::House(Actuator::Heater) => "heater",
        ActuatorId::House(Actuator::Fans) => "fans",
        ActuatorId::House(Actuator::RoofVents) => "roof_vents",
        ActuatorId::House(Actuator::Misters) => "misters",
        ActuatorId::House(Actuator::Co2Injector) => "co2_injector",
        ActuatorId::House(Actuator::GrowLights) => "grow_lights",
        ActuatorId::House(Actuator::ShadeScreen) => "shade_screen",
        ActuatorId::House(Actuator::IrrigationValve) | ActuatorId::Valve(_) => "irrigation_valve",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap as Map;

    fn config() -> Config {
        let mut cfg = Config::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        ))
        .expect("example config loads");
        cfg.sensing.no_response_window_ticks = 3;
        cfg
    }

    fn trusted_with_soil(soil: Map<Slug, Option<f64>>) -> TrustedState {
        TrustedState {
            temperature: Some(22.0),
            humidity: Some(60.0),
            co2: Some(800.0),
            par: Some(300.0),
            vpd: Some(1.0),
            soil_moisture: soil,
        }
    }

    #[test]
    fn stuck_actuator_is_detected_and_disabled() {
        let cfg = config();
        let mut health = HealthState::new();
        let heater = ActuatorId::House(Actuator::Heater);

        // We commanded the heater full last tick...
        let mut prev = Commands::all_off(&[]);
        prev.set(&heater, 100.0);
        // ...but it is observed stuck off.
        let observed = Commands::all_off(&[]);

        let mut faults = Vec::new();
        for _ in 0..cfg.sensing.no_response_window_ticks {
            faults.clear();
            health.monitor(
                Some(&prev),
                &observed,
                &trusted_with_soil(Map::new()),
                &cfg,
                &mut faults,
            );
        }
        assert!(health.disabled().contains(&heater));
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::ActuatorStuck)
        );
    }

    #[test]
    fn healthy_actuator_is_not_flagged() {
        let cfg = config();
        let mut health = HealthState::new();
        let heater = ActuatorId::House(Actuator::Heater);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater, 100.0);
        let mut faults = Vec::new();
        for _ in 0..10 {
            // observed == commanded → healthy.
            health.monitor(
                Some(&cmd),
                &cmd,
                &trusted_with_soil(Map::new()),
                &cfg,
                &mut faults,
            );
        }
        assert!(health.disabled().is_empty());
        assert!(faults.is_empty());
    }

    #[test]
    fn valve_no_response_disables_the_zone() {
        let cfg = config();
        let mut health = HealthState::new();
        let zone: Slug = "bench-a".parse().unwrap();
        let valve = ActuatorId::Valve(zone.clone());

        let mut prev = Commands::all_off(std::slice::from_ref(&zone));
        prev.set(&valve, 100.0); // valve commanded open
        let observed = prev.clone(); // it obeys (not stuck)

        let mut faults = Vec::new();
        // Soil stays flat despite the open valve.
        for _ in 0..(cfg.sensing.no_response_window_ticks + 1) {
            faults.clear();
            let mut soil = Map::new();
            soil.insert(zone.clone(), Some(0.20));
            health.monitor(
                Some(&prev),
                &observed,
                &trusted_with_soil(soil),
                &cfg,
                &mut faults,
            );
        }
        assert!(health.disabled().contains(&valve));
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::IrrigationNoResponse
                    && f.zone_id.as_ref() == Some(&zone))
        );
    }
}
