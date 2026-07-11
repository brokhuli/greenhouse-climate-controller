//! Lighting / DLI loop ([control-loops "Lighting — DLI accumulation"]).
//!
//! Accumulates the Daily Light Integral (mol·m⁻²·day⁻¹) by integrating PAR over the day. Each tick
//! it projects the natural DLI still to come before `day_end` from a controller-side clear-sky model
//! (`expected_peak_par` over the day window) and engages supplemental **grow lights** only when
//! `accumulated + expected_remaining < dli_target_mol` — so lights cover just the shortfall the sun
//! won't provide and switch off early on bright days rather than driving the target early and then
//! shading the still-abundant sun. The **shade screen** sheds excess once the target is met, but
//! only during the crop day (idle at night — no sun to block). The accumulator resets at each
//! simulated midnight. A faulted PAR sensor falls back to a time-based photoperiod (lights on during
//! the crop's day window), [sensing §4].

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

    /// The Daily Light Integral accumulated so far today (mol·m⁻²·d⁻¹); resets at simulated
    /// midnight. Surfaced in the system-state telemetry so the fleet view can show it.
    pub fn accumulated_dli(&self) -> f64 {
        self.accumulated_mol
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
                // Predict the natural DLI still to come before `day_end` from the operator's
                // clear-sky model, and supplement only the shortfall the sun won't cover. This
                // turns grow lights off early on bright days — and skips them entirely when the sun
                // alone will meet the target — instead of blasting until the target is hit and then
                // shading the still-abundant sun. `expected_peak_par = 0` disables the prediction,
                // degrading to the reactive "on whenever behind during the day" behavior.
                let remaining = expected_remaining_natural_dli(
                    f64::from(clock.second_of_day()),
                    f64::from(day_start) * 60.0,
                    f64::from(day_end) * 60.0,
                    cfg.setpoints.expected_peak_par,
                );
                let projected = self.accumulated_mol + remaining;
                let lights = if projected < target && in_day {
                    100.0
                } else {
                    0.0
                };
                // Shed excess solar once the day's target is already met — but only during the
                // crop day; at night there is no sun to block, so the screen stays idle (the
                // controller can't see the hidden solar disturbance, so it gates on the photoperiod).
                let shade = if self.accumulated_mol >= target && in_day {
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

/// Expected remaining natural DLI (mol·m⁻²) from `now` to sunset, modeling the day as a clear-sky
/// raised half-sine of `peak_par` (µmol·m⁻²·s⁻¹) over the `[sunrise, sunset)` window — all times in
/// seconds-of-day. It is the closed-form integral of that curve from `now` to sunset. A
/// controller-side estimate; it never reads the simulator's hidden solar model. Returns 0 once the
/// window has passed, or when the window or peak is non-positive (prediction disabled).
fn expected_remaining_natural_dli(
    now_secs: f64,
    sunrise_secs: f64,
    sunset_secs: f64,
    peak_par: f64,
) -> f64 {
    use std::f64::consts::PI;
    let window = sunset_secs - sunrise_secs;
    if window <= 0.0 || peak_par <= 0.0 || now_secs >= sunset_secs {
        return 0.0;
    }
    let t = now_secs.clamp(sunrise_secs, sunset_secs);
    // ∫ P·sin(π·(s−sr)/w) ds from t to ss = P·(w/π)·[cos(π·(t−sr)/w) − cos(π)], with cos(π) = −1.
    // Convert µmol·m⁻² → mol·m⁻² by dividing by 1e6.
    peak_par / 1_000_000.0 * (window / PI) * ((PI * (t - sunrise_secs) / window).cos() + 1.0)
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
        // Afternoon (15:00), high target (40): even crediting the clear-sky sun still to come
        // (~7 mol) the projection falls far short, so supplemental lights engage.
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
    fn shade_stays_idle_at_night_even_with_target_met() {
        // The DLI target is long since met, but at night there is no sun to block: the shade must
        // stay idle rather than apply a spurious cooling/PAR pull until the midnight reset.
        let cfg = config();
        let mut loop_ = LightingLoop::new();
        let shade = ActuatorId::House(Actuator::ShadeScreen);

        // Bank well past a tiny target during the day → shade deploys.
        let noon = Clock::starting_at_seconds(12 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(800.0)),
            &resolved(0.0001),
            &noon,
            &cfg,
            &mut cmd,
        );
        assert_eq!(cmd.get(&shade), 100.0, "shade deploys during the day");

        // Same accumulator, now after sunset (22:00): shade idle despite target met.
        let night = Clock::starting_at_seconds(22 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(0.0)),
            &resolved(0.0001),
            &night,
            &cfg,
            &mut cmd,
        );
        assert_eq!(
            cmd.get(&shade),
            0.0,
            "shade idle at night — no sun to block"
        );
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

    #[test]
    fn sunny_morning_projection_skips_lights() {
        // The core win: at 09:00 with a clear-sky peak of 800, the natural DLI still to come
        // (~23 mol) already covers the day's target (20), so grow lights stay OFF instead of
        // blasting all afternoon and overshooting.
        let cfg = config(); // example config carries expected_peak_par = 800
        let mut loop_ = LightingLoop::new();
        let morning = Clock::starting_at_seconds(9 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(100.0)),
            &resolved(20.0),
            &morning,
            &cfg,
            &mut cmd,
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 0.0);
        // Nowhere near the target yet, so the shade screen also stays retracted.
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::ShadeScreen)), 0.0);
    }

    #[test]
    fn behind_late_afternoon_with_little_sun_left_engages_lights() {
        // Late (18:00) with only a small clear-sky tail left (~1.3 mol) and far below target →
        // the projection still falls short, so lights supplement the genuine shortfall.
        let cfg = config();
        let mut loop_ = LightingLoop::new();
        let late = Clock::starting_at_seconds(18 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(&trusted(Some(50.0)), &resolved(20.0), &late, &cfg, &mut cmd);
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 100.0);
    }

    #[test]
    fn disabled_prediction_behaves_reactively() {
        // expected_peak_par = 0 disables the forecast: lights engage whenever behind during the
        // day window, regardless of time-of-day (no midday gate).
        let mut cfg = config();
        cfg.setpoints.expected_peak_par = 0.0;
        let mut loop_ = LightingLoop::new();
        let morning = Clock::starting_at_seconds(9 * 3600);
        let mut cmd = Commands::all_off(&[]);
        loop_.run(
            &trusted(Some(50.0)),
            &resolved(20.0),
            &morning,
            &cfg,
            &mut cmd,
        );
        assert_eq!(cmd.get(&ActuatorId::House(Actuator::GrowLights)), 100.0);
    }

    // Window in seconds-of-day for the example day (06:00–20:00).
    const SR: f64 = 6.0 * 3600.0;
    const SS: f64 = 20.0 * 3600.0;
    const PEAK: f64 = 800.0;

    fn full_day_dli() -> f64 {
        // Integral of the raised half-sine over the whole window: 2·P·w/(π·1e6).
        2.0 * PEAK * (SS - SR) / (std::f64::consts::PI * 1_000_000.0)
    }

    #[test]
    fn remaining_before_sunrise_is_full_day() {
        let r = expected_remaining_natural_dli(SR, SR, SS, PEAK);
        assert!(
            (r - full_day_dli()).abs() < 1e-9,
            "{r} vs {}",
            full_day_dli()
        );
    }

    #[test]
    fn remaining_at_solar_noon_is_half_of_full() {
        let noon = (SR + SS) / 2.0;
        let r = expected_remaining_natural_dli(noon, SR, SS, PEAK);
        assert!((r - full_day_dli() / 2.0).abs() < 1e-9);
    }

    #[test]
    fn remaining_after_sunset_is_zero() {
        assert_eq!(expected_remaining_natural_dli(SS, SR, SS, PEAK), 0.0);
        assert_eq!(expected_remaining_natural_dli(SS + 1.0, SR, SS, PEAK), 0.0);
    }

    #[test]
    fn remaining_zero_peak_is_zero() {
        assert_eq!(
            expected_remaining_natural_dli((SR + SS) / 2.0, SR, SS, 0.0),
            0.0
        );
    }

    #[test]
    fn remaining_degenerate_window_is_zero() {
        // sunset ≤ sunrise → no window → zero.
        assert_eq!(expected_remaining_natural_dli(SR, SS, SR, PEAK), 0.0);
    }
}
