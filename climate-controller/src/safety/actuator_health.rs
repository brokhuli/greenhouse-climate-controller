//! Actuator health monitoring — the output-side counterpart to sensor fault detection ([safety §5],
//! `P1-REL-4`).
//!
//! Runs every tick from three inputs: the **previous** tick's commanded levels, this tick's
//! **observed** readback, and this tick's **trusted readings** ([HAL §8]).
//!
//! - **Stuck** — observed diverges from the command beyond a tolerance for a window → disable the
//!   actuator (fail-safe) + `actuator_stuck` alarm.
//! - **No-response** — the actuator obeys but produces no climate effect. Detected for irrigation
//!   valves (commanded open but soil moisture not rising) as the spec's named
//!   `irrigation_no_response` interlock, and for the house **push** actuators (heater→temperature,
//!   misters→humidity, co2_injector→CO₂, grow_lights→PAR) under a masked-effect guard
//!   ([§5](safety §5)); the actuator/zone is disabled + alarm. Bidirectional actuators (fans, roof
//!   vents) are out of scope — their coupled, sign-ambiguous effects can't be cleanly disambiguated
//!   from masking.
//! - **Saturation** is *not* here — it's detected by the loops and never disables ([control-loops]).
//!   The push-actuator no-response guard is built to *not* fire on saturation (see below).
//!
//! Flags are **sticky** ([safety §5]): a disabled actuator is compared against the command the
//! controller *intended* (not the fail-safe forced-off command the pipeline substitutes), so its
//! divergence/no-effect persists and the disable holds until the actuator tracks its command again
//! — the pipeline supplies that intended baseline ([`pipeline`](crate::pipeline)).

use std::collections::{BTreeMap, BTreeSet};

use crate::config::Config;
use crate::control::ResolvedSetpoints;
use crate::domain::{Actuator, Slug};
use crate::faults::{Fault, FaultType, Severity};
use crate::hal::{ActuatorId, Commands, Observed};
use crate::sensing::TrustedState;

/// A house actuator is considered "commanded on" for no-response purposes at or above this level
/// (% / level). Set high enough that a lightly-modulating actuator isn't judged as actively pushing.
const HOUSE_ON_THRESHOLD: f64 = 50.0;

/// Across-tick actuator-health state.
#[derive(Debug, Clone, Default)]
pub struct HealthState {
    stuck_ticks: BTreeMap<ActuatorId, u64>,
    valve_flat_ticks: BTreeMap<Slug, u64>,
    valve_last_soil: BTreeMap<Slug, f64>,
    /// Per push actuator: consecutive ticks the driven variable has failed to respond.
    house_no_resp_ticks: BTreeMap<Actuator, u64>,
    /// Per push actuator: the variable value to beat for "responded". For non-floored actuators
    /// it's the best level seen since the current push challenge began (ratchets up); for PAR
    /// (floored) it's frozen at the challenge-start level, since PAR plateaus rather than climbing.
    house_no_resp_baseline: BTreeMap<Actuator, f64>,
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
        resolved: &ResolvedSetpoints,
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

        // No-response detection for the house "push" actuators. Each drives one climate variable in
        // a single direction. A challenge runs while the actuator is commanded substantially on and
        // its variable is below target (a response is *expected* — this guards out a masked/at-target
        // effect). "Responded" is asymmetric by physics:
        //   • temperature / humidity / CO₂ have no hard floor, so a *saturated* (working but
        //     undersized) actuator at least *holds* the variable — only a variable that **declines**
        //     past a noise margin despite the push is no-response. Saturation never disables here.
        //   • PAR floors at ~0 and grow-lights only run under a deficit, so the no-response signal is
        //     PAR failing to **rise** above where it started (the irrigation-valve pattern).
        for desc in [
            HouseNoResponse::new(
                Actuator::Heater,
                trusted.temperature,
                trusted.temperature.map(|t| t < resolved.temperature_c),
                false,
            ),
            HouseNoResponse::new(
                Actuator::Misters,
                trusted.humidity,
                trusted.humidity.map(|h| {
                    h < resolved
                        .humidity_target_pct
                        .unwrap_or(resolved.humidity_low_pct)
                }),
                false,
            ),
            HouseNoResponse::new(
                Actuator::Co2Injector,
                trusted.co2,
                trusted.co2.map(|c| c < resolved.co2_target_ppm),
                false,
            ),
            // Grow-lights are commanded only under a DLI deficit, so "expected" reduces to PAR trusted.
            HouseNoResponse::new(
                Actuator::GrowLights,
                trusted.par,
                trusted.par.map(|_| true),
                true,
            ),
        ] {
            let id = ActuatorId::House(desc.actuator);
            let commanded_on = prev.get(&id) >= HOUSE_ON_THRESHOLD;
            let eligible = commanded_on && desc.expected == Some(true);
            match desc.value {
                Some(v) if eligible => {
                    let margin = no_response_margin(desc.actuator);
                    match self.house_no_resp_baseline.get(&desc.actuator).copied() {
                        // Challenge starts: record the level to beat, evaluate from the next tick.
                        None => {
                            self.house_no_resp_baseline.insert(desc.actuator, v);
                            self.house_no_resp_ticks.insert(desc.actuator, 0);
                        }
                        Some(baseline) => {
                            let responded = if desc.floored {
                                v > baseline + margin // PAR must climb above where it started
                            } else {
                                v >= baseline - margin // temp/RH/CO₂ must at least hold
                            };
                            if responded {
                                // Non-floored actuators ratchet the baseline to the best level seen,
                                // so a later decline past it reads as no-response. PAR (floored) must
                                // instead hold its comparison against *where the challenge started*:
                                // it plateaus once the lights are on and stops rising, so ratcheting
                                // up here would make a healthy, holding PAR look like no-response.
                                if !desc.floored && v > baseline {
                                    self.house_no_resp_baseline.insert(desc.actuator, v);
                                }
                                self.house_no_resp_ticks.insert(desc.actuator, 0);
                            } else {
                                let count =
                                    self.house_no_resp_ticks.entry(desc.actuator).or_insert(0);
                                *count += 1;
                                if *count >= window {
                                    self.disabled.insert(id.clone());
                                    faults.push(Fault::new(
                                        component_name(&id),
                                        FaultType::ActuatorNoResponse,
                                        Severity::Alarm,
                                        format!(
                                            "{} commanded on but {} is not responding",
                                            component_name(&id),
                                            driven_variable(desc.actuator)
                                        ),
                                        "disabled the actuator",
                                    ));
                                }
                            }
                        }
                    }
                }
                // Off, masked/at-target, or untrusted this tick — the challenge resets.
                _ => {
                    self.house_no_resp_baseline.remove(&desc.actuator);
                    self.house_no_resp_ticks.remove(&desc.actuator);
                }
            }
        }
    }

    /// Actuators currently disabled by a health fault. The pipeline forces these off (waiving dwell).
    pub fn disabled(&self) -> &BTreeSet<ActuatorId> {
        &self.disabled
    }
}

/// One push-actuator no-response descriptor for a tick: the actuator, its driven variable's trusted
/// value, whether a response is currently *expected* (variable below target), and whether the
/// variable floors at ~0 (so no-response means "failed to rise" rather than "declined").
struct HouseNoResponse {
    actuator: Actuator,
    value: Option<f64>,
    expected: Option<bool>,
    floored: bool,
}

impl HouseNoResponse {
    fn new(actuator: Actuator, value: Option<f64>, expected: Option<bool>, floored: bool) -> Self {
        HouseNoResponse {
            actuator,
            value,
            expected,
            floored,
        }
    }
}

/// The minimum change that counts as a real response/decline for a push actuator's driven variable,
/// chosen above typical sensor noise so noise alone neither clears nor triggers a no-response.
fn no_response_margin(actuator: Actuator) -> f64 {
    match actuator {
        Actuator::Heater => 0.2,       // °C
        Actuator::Misters => 1.0,      // %RH
        Actuator::Co2Injector => 10.0, // ppm
        Actuator::GrowLights => 10.0,  // µmol·m⁻²·s⁻¹
        _ => 0.0,
    }
}

/// Human label for the variable a push actuator drives, for the no-response fault message.
fn driven_variable(actuator: Actuator) -> &'static str {
    match actuator {
        Actuator::Heater => "air temperature",
        Actuator::Misters => "humidity",
        Actuator::Co2Injector => "CO₂",
        Actuator::GrowLights => "PAR",
        _ => "its driven variable",
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

    /// Resolved setpoints whose targets sit *above* `trusted_with_soil`'s readings, so the push
    /// actuators are "expected to respond" (a response is awaited) in the no-response tests.
    fn resolved() -> ResolvedSetpoints {
        ResolvedSetpoints {
            temperature_c: 24.0,
            humidity_target_pct: Some(70.0),
            humidity_low_pct: 40.0,
            humidity_high_pct: 85.0,
            humidity_deadband_pct: 5.0,
            co2_target_ppm: 1000.0,
            vent_interlock_threshold_pct: 50.0,
            dli_target_mol: 20.0,
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
                &resolved(),
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
            // observed == commanded → healthy; temperature holds at setpoint → no no-response.
            health.monitor(
                Some(&cmd),
                &cmd,
                &trusted_with_soil(Map::new()),
                &resolved(),
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
                &resolved(),
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

    #[test]
    fn heater_no_response_when_temperature_falls_despite_command() {
        // Heater commanded full and observed obeying (not stuck), yet temperature keeps falling
        // below setpoint — a no-effect actuator. Should disable + raise actuator_no_response.
        let cfg = config(); // window = 3
        let mut health = HealthState::new();
        let heater = ActuatorId::House(Actuator::Heater);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater, 100.0);
        let observed = cmd.clone();

        let mut faults = Vec::new();
        for &t in &[22.0, 21.5, 21.0, 20.5, 20.0] {
            faults.clear();
            let mut trusted = trusted_with_soil(Map::new());
            trusted.temperature = Some(t);
            health.monitor(
                Some(&cmd),
                &observed,
                &trusted,
                &resolved(),
                &cfg,
                &mut faults,
            );
        }
        assert!(health.disabled().contains(&heater));
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::ActuatorNoResponse)
        );
    }

    #[test]
    fn saturated_heater_that_holds_temperature_is_not_flagged() {
        // Heater full, below setpoint, but holding temperature steady = *saturation*, not
        // no-response. The spec is explicit that saturation must never disable.
        let cfg = config();
        let mut health = HealthState::new();
        let heater = ActuatorId::House(Actuator::Heater);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater, 100.0);

        let mut faults = Vec::new();
        for _ in 0..10 {
            faults.clear();
            let mut trusted = trusted_with_soil(Map::new());
            trusted.temperature = Some(22.0); // below the 24 °C target, but steady
            health.monitor(Some(&cmd), &cmd, &trusted, &resolved(), &cfg, &mut faults);
        }
        assert!(health.disabled().is_empty());
        assert!(
            !faults
                .iter()
                .any(|f| f.fault_type == FaultType::ActuatorNoResponse)
        );
    }

    #[test]
    fn heater_at_setpoint_is_not_flagged() {
        // At/above setpoint the heater's effect is masked (no response expected) → never flagged.
        let cfg = config();
        let mut health = HealthState::new();
        let heater = ActuatorId::House(Actuator::Heater);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater, 100.0);

        let mut faults = Vec::new();
        for _ in 0..10 {
            faults.clear();
            let mut trusted = trusted_with_soil(Map::new());
            trusted.temperature = Some(25.0); // above the 24 °C target
            health.monitor(Some(&cmd), &cmd, &trusted, &resolved(), &cfg, &mut faults);
        }
        assert!(health.disabled().is_empty());
        assert!(faults.is_empty());
    }

    #[test]
    fn grow_lights_no_response_when_par_does_not_rise() {
        // Lights commanded on (a DLI deficit) but PAR never rises off the floor → no-response.
        let cfg = config();
        let mut health = HealthState::new();
        let lights = ActuatorId::House(Actuator::GrowLights);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&lights, 100.0);

        let mut faults = Vec::new();
        for _ in 0..(cfg.sensing.no_response_window_ticks + 2) {
            faults.clear();
            let mut trusted = trusted_with_soil(Map::new());
            trusted.par = Some(0.0); // lights on, but no photons
            health.monitor(Some(&cmd), &cmd, &trusted, &resolved(), &cfg, &mut faults);
        }
        assert!(health.disabled().contains(&lights));
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::ActuatorNoResponse)
        );
    }

    #[test]
    fn grow_lights_not_flagged_when_par_rises_then_plateaus() {
        // Lights commanded on; PAR ramps up to a plateau and holds there (the digital twin's
        // first-order response — photons stop climbing once the lamp is fully on). PAR clearly
        // responded, so no fault: the no-response challenge must compare against where it started,
        // not ratchet up to the best level seen (which would make a holding PAR look dead).
        let cfg = config();
        let mut health = HealthState::new();
        let lights = ActuatorId::House(Actuator::GrowLights);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&lights, 100.0);

        let mut faults = Vec::new();
        // Ramp 50 → 800, then hold at 800 for well past the window.
        for &par in &[50.0, 200.0, 500.0, 800.0, 800.0, 800.0, 800.0, 800.0] {
            faults.clear();
            let mut trusted = trusted_with_soil(Map::new());
            trusted.par = Some(par);
            health.monitor(Some(&cmd), &cmd, &trusted, &resolved(), &cfg, &mut faults);
        }
        assert!(health.disabled().is_empty());
        assert!(
            !faults
                .iter()
                .any(|f| f.fault_type == FaultType::ActuatorNoResponse)
        );
    }
}
