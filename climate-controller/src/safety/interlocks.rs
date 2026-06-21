//! Safety interlocks — pipeline stage ⑤ ([safety §2]).
//!
//! Always active; **unconditional priority** over the control loops *and* manual override. A
//! detected condition is acted on **within one tick** (`P1-REL-1`) — assert is immediate. Clearing
//! is hysteretic: the reading must recover past an `interlock_rearm_hysteresis` margin **and** a
//! `interlock_min_hold` dwell must elapse, so a reading hovering at the threshold cannot chatter.
//! Interlocks return the set of actuators they forced so the [constraints](super::constraints)
//! stage waives anti-short-cycle dwell on a move *toward* a safe state ([safety §3]).

use std::collections::BTreeSet;

use crate::clock::Clock;
use crate::config::Config;
use crate::domain::Actuator;
use crate::faults::{Fault, FaultType, Severity};
use crate::hal::{ActuatorId, Commands};
use crate::sensing::TrustedState;

/// An asymmetric assert/clear latch: asserts immediately, clears only after recovery + dwell.
#[derive(Debug, Clone, Default)]
struct Latch {
    asserted: bool,
    asserted_at_tick: u64,
}

impl Latch {
    /// Update the latch. `over` = reading above the trigger threshold (assert); `recovered` =
    /// reading below the (threshold − rearm) margin (permits clear). Returns the asserted state.
    fn update(&mut self, over: bool, recovered: bool, clock: &Clock, min_hold: u64) -> bool {
        if self.asserted {
            let held = clock.tick_index().saturating_sub(self.asserted_at_tick) >= min_hold;
            if recovered && held {
                self.asserted = false;
            }
        } else if over {
            self.asserted = true;
            self.asserted_at_tick = clock.tick_index();
        }
        self.asserted
    }
}

/// Across-tick interlock state (the per-interlock latches).
#[derive(Debug, Clone, Default)]
pub struct InterlockState {
    critical_temperature: Latch,
    co2_ceiling: Latch,
}

impl InterlockState {
    /// No interlocks asserted.
    pub fn new() -> Self {
        InterlockState::default()
    }

    /// Apply all interlocks to `cmd`, returning the actuators forced this tick. Runs after manual
    /// override, so a forced safe state overrides operator intent too.
    pub fn apply(
        &mut self,
        trusted: &TrustedState,
        cfg: &Config,
        clock: &Clock,
        cmd: &mut Commands,
        faults: &mut Vec<Fault>,
    ) -> BTreeSet<ActuatorId> {
        let mut forced = BTreeSet::new();
        let safety = &cfg.safety;
        let min_hold = safety.interlock_min_hold_secs;

        match trusted.temperature {
            Some(t) => {
                let over = t > safety.critical_temperature_c;
                let recovered = t < safety.critical_temperature_c
                    - safety.interlock_rearm_hysteresis.temperature_c;
                if self
                    .critical_temperature
                    .update(over, recovered, clock, min_hold)
                {
                    // Override all loops: heater off, run all cooling at full.
                    force(cmd, &mut forced, Actuator::Heater, 0.0);
                    force(cmd, &mut forced, Actuator::Fans, 100.0);
                    force(cmd, &mut forced, Actuator::RoofVents, 100.0);
                    faults.push(Fault::new(
                        "temperature",
                        FaultType::CriticalTemperature,
                        Severity::Alarm,
                        format!(
                            "air temperature {t:.1}°C above critical max {:.1}°C",
                            safety.critical_temperature_c
                        ),
                        "heater off; all cooling at full",
                    ));
                }
            }
            None => {
                // Temperature unavailable: hold a safe state — never heat blind. The unavailable
                // fault itself is raised by sensing; here we hold actuators safe.
                force(cmd, &mut forced, Actuator::Heater, 0.0);
                force(cmd, &mut forced, Actuator::Fans, 0.0);
                force(cmd, &mut forced, Actuator::RoofVents, 0.0);
                // Clear any standing critical-temperature latch — we no longer have a reading.
                self.critical_temperature = Latch::default();
            }
        }

        if let Some(c) = trusted.co2 {
            let ceiling = f64::from(safety.co2_ceiling_ppm);
            let over = c > ceiling;
            let recovered = c < ceiling - safety.interlock_rearm_hysteresis.co2_ppm;
            if self.co2_ceiling.update(over, recovered, clock, min_hold) {
                force(cmd, &mut forced, Actuator::RoofVents, 100.0);
                force(cmd, &mut forced, Actuator::Co2Injector, 0.0);
                faults.push(Fault::new(
                    "co2",
                    FaultType::Co2Ceiling,
                    Severity::Alarm,
                    format!("CO₂ {c:.0} ppm above safety ceiling {ceiling:.0} ppm"),
                    "vents open; CO₂ injector disabled",
                ));
            }
        }

        forced
    }
}

fn force(cmd: &mut Commands, forced: &mut BTreeSet<ActuatorId>, actuator: Actuator, level: f64) {
    let id = ActuatorId::House(actuator);
    cmd.set(&id, level);
    forced.insert(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        ))
        .expect("example config loads")
    }

    fn trusted(temp: Option<f64>, co2: Option<f64>) -> TrustedState {
        TrustedState {
            temperature: temp,
            humidity: Some(60.0),
            co2,
            par: Some(300.0),
            vpd: Some(1.0),
            soil_moisture: Default::default(),
        }
    }

    fn heater(cmd: &Commands) -> f64 {
        cmd.get(&ActuatorId::House(Actuator::Heater))
    }
    fn vents(cmd: &Commands) -> f64 {
        cmd.get(&ActuatorId::House(Actuator::RoofVents))
    }
    fn injector(cmd: &Commands) -> f64 {
        cmd.get(&ActuatorId::House(Actuator::Co2Injector))
    }

    #[test]
    fn critical_temperature_asserts_immediately_and_full_cools() {
        let cfg = config();
        let mut state = InterlockState::new();
        let clock = Clock::new();
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&ActuatorId::House(Actuator::Heater), 100.0); // a loop/override wanted heat
        let mut faults = Vec::new();
        let forced = state.apply(
            &trusted(Some(45.0), Some(800.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut faults,
        );
        assert_eq!(heater(&cmd), 0.0, "critical temp forces heater off");
        assert_eq!(vents(&cmd), 100.0, "full cooling");
        assert!(forced.contains(&ActuatorId::House(Actuator::Heater)));
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::CriticalTemperature)
        );
    }

    #[test]
    fn critical_temperature_clear_is_hysteretic() {
        let mut cfg = config();
        cfg.safety.critical_temperature_c = 40.0;
        cfg.safety.interlock_rearm_hysteresis.temperature_c = 2.0;
        cfg.safety.interlock_min_hold_secs = 3;
        let mut state = InterlockState::new();
        let mut clock = Clock::new();

        // Assert at 45 °C.
        let mut cmd = Commands::all_off(&[]);
        state.apply(
            &trusted(Some(45.0), Some(800.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut Vec::new(),
        );

        // Back to 39 °C (below threshold but within the 2° rearm margin, and dwell not met):
        // stays asserted.
        clock.advance();
        let mut cmd = Commands::all_off(&[]);
        let forced = state.apply(
            &trusted(Some(39.0), Some(800.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut Vec::new(),
        );
        assert!(
            forced.contains(&ActuatorId::House(Actuator::RoofVents)),
            "still asserted near threshold"
        );

        // Well below rearm (37 °C) and past the dwell → clears.
        for _ in 0..4 {
            clock.advance();
        }
        let mut cmd = Commands::all_off(&[]);
        let forced = state.apply(
            &trusted(Some(37.0), Some(800.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut Vec::new(),
        );
        assert!(forced.is_empty(), "interlock should have cleared");
    }

    #[test]
    fn co2_ceiling_opens_vents_and_disables_injector() {
        let cfg = config();
        let mut state = InterlockState::new();
        let clock = Clock::new();
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&ActuatorId::House(Actuator::Co2Injector), 100.0);
        let mut faults = Vec::new();
        state.apply(
            &trusted(Some(24.0), Some(6000.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut faults,
        );
        assert_eq!(vents(&cmd), 100.0);
        assert_eq!(injector(&cmd), 0.0);
        assert!(faults.iter().any(|f| f.fault_type == FaultType::Co2Ceiling));
    }

    #[test]
    fn temperature_unavailable_holds_safe_state() {
        let cfg = config();
        let mut state = InterlockState::new();
        let clock = Clock::new();
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&ActuatorId::House(Actuator::Heater), 100.0);
        let forced = state.apply(
            &trusted(None, Some(800.0)),
            &cfg,
            &clock,
            &mut cmd,
            &mut Vec::new(),
        );
        assert_eq!(
            heater(&cmd),
            0.0,
            "no blind heating when temperature is unavailable"
        );
        assert!(forced.contains(&ActuatorId::House(Actuator::Heater)));
    }
}
