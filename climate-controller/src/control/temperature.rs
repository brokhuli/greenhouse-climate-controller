//! Temperature PID loop ([control-loops "Temperature PID"]).
//!
//! Reads the fused air temperature, runs a [`Pid`](super::pid::Pid), and drives the **heater**
//! (heating mode) or **fans + roof vents** (cooling mode) — the sign of the error selects the
//! mode. A small deadband around the setpoint plus the PID's clamped integral prevent chatter at
//! the heating↔cooling crossover. Sustained railing raises `setpoint_unreachable` while the loop
//! keeps driving at the limit ([control-loops saturation]).

use crate::clock::DT_SECS;
use crate::config::Config;
use crate::domain::Actuator;
use crate::faults::{Fault, FaultType, Severity};
use crate::hal::{ActuatorId, Commands};
use crate::sensing::TrustedState;

use super::ResolvedSetpoints;
use super::pid::Pid;

/// Half-width of the no-action band around the setpoint (°C).
const DEADBAND_C: f64 = 0.5;

/// The temperature loop and its across-tick state.
#[derive(Debug, Clone)]
pub struct TemperatureLoop {
    pid: Pid,
    saturation_ticks: u64,
}

impl TemperatureLoop {
    /// Build from configured gains.
    pub fn new(cfg: &Config) -> Self {
        TemperatureLoop {
            pid: Pid::from_config(&cfg.control.temperature_pid),
            saturation_ticks: 0,
        }
    }

    /// Compute desired heater/fans/vents and write them into `cmd`.
    pub fn run(
        &mut self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        cmd: &mut Commands,
        cfg: &Config,
        faults: &mut Vec<Fault>,
    ) {
        let (heater, cooling) = self.compute(trusted, resolved, cfg, faults);
        cmd.set(&ActuatorId::House(Actuator::Heater), heater);
        // Fans and vents share the temperature loop's cooling mode (the temperature loop owns
        // their position; humidity/CO₂ loops read the resulting state, [control-loops coupling]).
        cmd.set(&ActuatorId::House(Actuator::Fans), cooling);
        cmd.set(&ActuatorId::House(Actuator::RoofVents), cooling);
    }

    /// Returns `(heater_level, cooling_level)`.
    fn compute(
        &mut self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        cfg: &Config,
        faults: &mut Vec<Fault>,
    ) -> (f64, f64) {
        let temperature = match trusted.temperature {
            Some(t) => t,
            None => {
                // Temperature unavailable: suspend the loop (safety holds the safe state). Reset so
                // no accumulated correction is dumped when trust returns.
                self.pid.reset();
                self.saturation_ticks = 0;
                return (0.0, 0.0);
            }
        };

        let error = resolved.temperature_c - temperature;
        let output = self.pid.update(error, DT_SECS as f64);

        // Within the deadband: idle both modes (prevents crossover chatter).
        if error.abs() <= DEADBAND_C {
            self.note_saturation(false, cfg, faults);
            return (0.0, 0.0);
        }

        let (heater, cooling) = if output > 0.0 {
            (output.clamp(0.0, 100.0), 0.0)
        } else {
            (0.0, (-output).clamp(0.0, 100.0))
        };

        // Saturated = pinned at a rail while the error persists beyond the deadband.
        let railed = heater >= 100.0 || cooling >= 100.0;
        self.note_saturation(railed, cfg, faults);

        (heater, cooling)
    }

    /// Track sustained saturation and raise `setpoint_unreachable` once it exceeds the window
    /// (warning, escalating to alarm) — the loop keeps driving at the rail regardless.
    fn note_saturation(&mut self, saturated: bool, cfg: &Config, faults: &mut Vec<Fault>) {
        if saturated {
            self.saturation_ticks += 1;
        } else {
            self.saturation_ticks = 0;
            return;
        }
        let window = cfg.control.saturation_window_secs;
        if self.saturation_ticks >= window {
            let severity = if self.saturation_ticks >= window.saturating_mul(2) {
                Severity::Alarm
            } else {
                Severity::Warning
            };
            faults.push(Fault::new(
                "temperature",
                FaultType::SetpointUnreachable,
                severity,
                format!(
                    "temperature setpoint unreachable: saturated for {} ticks",
                    self.saturation_ticks
                ),
                "holding the actuator at its limit (keep controlling)",
            ));
        }
    }
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

    fn resolved(setpoint: f64) -> ResolvedSetpoints {
        ResolvedSetpoints {
            temperature_c: setpoint,
            humidity_target_pct: Some(60.0),
            humidity_low_pct: 50.0,
            humidity_high_pct: 85.0,
            humidity_deadband_pct: 5.0,
            co2_target_ppm: 1000.0,
            vent_interlock_threshold_pct: 15.0,
            dli_target_mol: 20.0,
        }
    }

    fn trusted(temp: Option<f64>) -> TrustedState {
        TrustedState {
            temperature: temp,
            humidity: Some(60.0),
            co2: Some(800.0),
            par: Some(300.0),
            vpd: Some(1.0),
            soil_moisture: Default::default(),
        }
    }

    #[test]
    fn cold_calls_for_heat() {
        let cfg = config();
        let mut loop_ = TemperatureLoop::new(&cfg);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(10.0)),
            &resolved(24.0),
            &mut cmd,
            &cfg,
            &mut Vec::new(),
        );
        assert!(cmd.get(&ActuatorId::House(Actuator::Heater)) > 0.0);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Fans)), 0.0);
    }

    #[test]
    fn hot_calls_for_cooling() {
        let cfg = config();
        let mut loop_ = TemperatureLoop::new(&cfg);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(35.0)),
            &resolved(24.0),
            &mut cmd,
            &cfg,
            &mut Vec::new(),
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Heater)), 0.0);
        assert!(cmd.get(&ActuatorId::House(Actuator::Fans)) > 0.0);
        assert!(cmd.get(&ActuatorId::House(Actuator::RoofVents)) > 0.0);
    }

    #[test]
    fn at_setpoint_idles() {
        let cfg = config();
        let mut loop_ = TemperatureLoop::new(&cfg);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(24.0)),
            &resolved(24.0),
            &mut cmd,
            &cfg,
            &mut Vec::new(),
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Heater)), 0.0);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Fans)), 0.0);
    }

    #[test]
    fn unavailable_temperature_suspends_loop() {
        let cfg = config();
        let mut loop_ = TemperatureLoop::new(&cfg);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(None),
            &resolved(24.0),
            &mut cmd,
            &cfg,
            &mut Vec::new(),
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Heater)), 0.0);
    }

    #[test]
    fn sustained_saturation_raises_setpoint_unreachable() {
        let mut cfg = config();
        cfg.control.saturation_window_secs = 3;
        let mut loop_ = TemperatureLoop::new(&cfg);
        let mut faults = Vec::new();
        // A wildly unreachable setpoint keeps the heater railed at 100%.
        for _ in 0..5 {
            let mut cmd = Commands::all_off(&[]);
            loop_.run(
                &trusted(Some(0.0)),
                &resolved(50.0),
                &mut cmd,
                &cfg,
                &mut faults,
            );
            assert_eq!(cmd.get(&ActuatorId::House(Actuator::Heater)), 100.0);
        }
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::SetpointUnreachable),
            "expected setpoint_unreachable after sustained saturation"
        );
    }
}
