//! Humidity hysteresis loop with VPD feedforward ([control-loops "Humidity hysteresis band"]).
//!
//! The target RH is **derived from the VPD setpoint** at the fused temperature during
//! [setpoint resolution](super::resolve) and clamped to the humidity safety bounds. Misters (an
//! on/off solenoid) ride a hysteresis band of width `humidity_deadband_pct` around that target.
//! Two degraded paths: temperature unavailable → the target can't be derived, so fall back to the
//! midpoint of the safety bounds and keep running on RH feedback; humidity faulted → no feedback,
//! so fail safe (misters off).

use crate::domain::Actuator;
use crate::hal::{ActuatorId, Commands};
use crate::sensing::TrustedState;

use super::ResolvedSetpoints;

/// The humidity loop; holds the on/off hysteresis latch.
#[derive(Debug, Clone, Default)]
pub struct HumidityLoop {
    misters_on: bool,
}

impl HumidityLoop {
    /// Build the loop (latch starts off).
    pub fn new() -> Self {
        HumidityLoop::default()
    }

    /// Compute the desired misters level and write it into `cmd`.
    pub fn run(
        &mut self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        cmd: &mut Commands,
    ) {
        let level = self.compute(trusted, resolved);
        cmd.set(&ActuatorId::House(Actuator::Misters), level);
    }

    fn compute(&mut self, trusted: &TrustedState, resolved: &ResolvedSetpoints) -> f64 {
        let humidity = match trusted.humidity {
            Some(h) => h,
            None => {
                // No RH feedback: fail safe.
                self.misters_on = false;
                return 0.0;
            }
        };

        // Derived target if temperature is available, else the midpoint of the safety bounds.
        let target = resolved
            .humidity_target_pct
            .unwrap_or_else(|| (resolved.humidity_low_pct + resolved.humidity_high_pct) / 2.0);
        let half = resolved.humidity_deadband_pct / 2.0;

        if humidity < target - half {
            self.misters_on = true;
        } else if humidity > target + half {
            self.misters_on = false;
        }

        if self.misters_on { 100.0 } else { 0.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(target: Option<f64>) -> ResolvedSetpoints {
        ResolvedSetpoints {
            temperature_c: 24.0,
            humidity_target_pct: target,
            humidity_low_pct: 50.0,
            humidity_high_pct: 80.0,
            humidity_deadband_pct: 10.0,
            co2_target_ppm: 1000.0,
            vent_interlock_threshold_pct: 15.0,
            dli_target_mol: 20.0,
        }
    }

    fn trusted(humidity: Option<f64>) -> TrustedState {
        TrustedState {
            temperature: Some(24.0),
            humidity,
            co2: Some(800.0),
            par: Some(300.0),
            vpd: Some(1.0),
            soil_moisture: Default::default(),
        }
    }

    #[test]
    fn dry_air_turns_misters_on_and_latches() {
        let mut loop_ = HumidityLoop::new();
        let mut cmd = Commands::all_off(&[]);
        // target 70, band 10 → on below 65, off above 75.
        loop_.run(&trusted(Some(60.0)), &resolved(Some(70.0)), &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Misters)), 100.0);
        // Still within the band (68): latch holds on.
        loop_.run(&trusted(Some(68.0)), &resolved(Some(70.0)), &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Misters)), 100.0);
        // Above the upper edge: turns off.
        loop_.run(&trusted(Some(76.0)), &resolved(Some(70.0)), &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Misters)), 0.0);
    }

    #[test]
    fn humidity_fault_fails_safe() {
        let mut loop_ = HumidityLoop::new();
        let mut cmd = Commands::all_off(&[]);
        loop_.run(&trusted(Some(30.0)), &resolved(Some(70.0)), &mut cmd); // on
        loop_.run(&trusted(None), &resolved(Some(70.0)), &mut cmd); // sensor lost
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Misters)), 0.0);
    }

    #[test]
    fn temperature_unavailable_falls_back_to_midpoint_band() {
        let mut loop_ = HumidityLoop::new();
        let mut cmd = Commands::all_off(&[]);
        // No derived target → midpoint of [50,80] = 65, band 10 → on below 60.
        loop_.run(&trusted(Some(55.0)), &resolved(None), &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::Misters)), 100.0);
    }
}
