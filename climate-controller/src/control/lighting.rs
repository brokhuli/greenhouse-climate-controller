//! Lighting / DLI loop ([control-loops "Lighting — DLI accumulation"]).
//!
//! Accumulates the Daily Light Integral (mol·m⁻²·day⁻¹) by integrating PAR over the day. If the
//! `dli_target_mol` is behind pace by midday, supplemental **grow lights** engage for the
//! afternoon; the **shade screen** sheds excess once the target is met. The accumulator resets at
//! each simulated midnight. A faulted PAR sensor falls back to a time-based photoperiod (lights on
//! during the crop's day window), [sensing §4].

use crate::clock::{Clock, DT_SECS};
use crate::config::Config;
use crate::domain::Actuator;
use crate::hal::{ActuatorId, Commands};
use crate::sensing::TrustedState;

use super::ResolvedSetpoints;

/// The lighting loop; tracks the day index and accumulated DLI.
#[derive(Debug, Clone)]
pub struct LightingLoop {
    day_index: u64,
    accumulated_mol: f64,
}

impl LightingLoop {
    /// Build the loop (accumulator starts at zero).
    pub fn new() -> Self {
        LightingLoop {
            day_index: 0,
            accumulated_mol: 0.0,
        }
    }

    /// Accumulate DLI and write desired grow-lights + shade-screen levels into `cmd`.
    pub fn run(
        &mut self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        clock: &Clock,
        cfg: &Config,
        cmd: &mut Commands,
    ) {
        // Reset the accumulator at each simulated midnight.
        let day = clock.sim_seconds() / Clock::DAY_SECS;
        if day != self.day_index {
            self.day_index = day;
            self.accumulated_mol = 0.0;
        }

        // Integrate trusted PAR (µmol·m⁻²·s⁻¹ → mol·m⁻²) over Δt.
        if let Some(par) = trusted.par {
            self.accumulated_mol += par * (DT_SECS as f64) / 1_000_000.0;
        }

        let (lights, shade) = self.decide(trusted, resolved, clock, cfg);
        cmd.set(&ActuatorId::House(Actuator::GrowLights), lights);
        cmd.set(&ActuatorId::House(Actuator::ShadeScreen), shade);
    }

    /// Returns `(grow_lights_level, shade_screen_level)`.
    fn decide(
        &self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        clock: &Clock,
        cfg: &Config,
    ) -> (f64, f64) {
        let day_start = cfg.setpoints.day_start.minutes_since_midnight();
        let day_end = cfg.setpoints.day_end.minutes_since_midnight();
        let now = clock.minute_of_day();
        let in_day = now >= day_start && now < day_end;

        match trusted.par {
            // PAR fault: time-based fallback — lights track the photoperiod, no shading.
            None => (if in_day { 100.0 } else { 0.0 }, 0.0),
            Some(_) => {
                let target = resolved.dli_target_mol;
                let past_midday = now >= (day_start + day_end) / 2;
                let behind = self.accumulated_mol < target;
                let lights = if behind && past_midday && in_day {
                    100.0
                } else {
                    0.0
                };
                // Shed excess solar once the day's target is already met.
                let shade = if self.accumulated_mol >= target {
                    100.0
                } else {
                    0.0
                };
                (lights, shade)
            }
        }
    }
}

impl Default for LightingLoop {
    fn default() -> Self {
        LightingLoop::new()
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

    fn resolved(dli_target: f64) -> ResolvedSetpoints {
        ResolvedSetpoints {
            temperature_c: 24.0,
            humidity_target_pct: Some(60.0),
            humidity_low_pct: 50.0,
            humidity_high_pct: 85.0,
            humidity_deadband_pct: 5.0,
            co2_target_ppm: 1000.0,
            vent_interlock_threshold_pct: 15.0,
            dli_target_mol: dli_target,
        }
    }

    fn trusted(par: Option<f64>) -> TrustedState {
        TrustedState {
            temperature: Some(24.0),
            humidity: Some(60.0),
            co2: Some(800.0),
            par,
            vpd: Some(1.0),
            soil_moisture: Default::default(),
        }
    }

    #[test]
    fn behind_target_in_afternoon_engages_lights() {
        let cfg = config();
        let mut loop_ = LightingLoop::new();
        // Afternoon (15:00), low PAR, high target → behind → lights on.
        let afternoon = Clock::starting_at_seconds(15 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(50.0)),
            &resolved(40.0),
            &afternoon,
            &cfg,
            &mut cmd,
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 100.0);
    }

    #[test]
    fn meeting_target_engages_shade() {
        let cfg = config();
        let mut loop_ = LightingLoop::new();
        let noon = Clock::starting_at_seconds(12 * 3600);
        let mut cmd = Commands::all_off(&[]);
        // A tiny target is met after one accumulation step → shade on.
        loop_.run(
            &trusted(Some(800.0)),
            &resolved(0.0001),
            &noon,
            &cfg,
            &mut cmd,
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::ShadeScreen)), 100.0);
    }

    #[test]
    fn par_fault_falls_back_to_photoperiod() {
        let cfg = config();
        let mut loop_ = LightingLoop::new();
        let mut cmd = Commands::all_off(&[]);
        // Daytime, PAR sensor lost → lights on by schedule.
        let noon = Clock::starting_at_seconds(12 * 3600);
        loop_.run(&trusted(None), &resolved(20.0), &noon, &cfg, &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 100.0);
        // Night, PAR sensor lost → lights off.
        let night = Clock::starting_at_seconds(2 * 3600);
        loop_.run(&trusted(None), &resolved(20.0), &night, &cfg, &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 0.0);
    }
}
