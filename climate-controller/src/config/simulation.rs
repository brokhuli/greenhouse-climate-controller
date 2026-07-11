//! Simulation tunables (`[simulation]`, controller spec §3 §7, §7).
//!
//! Seed and time-scale for the [HAL simulator](../hal), the day-cycle (solar/PAR) disturbance
//! parameters, the initial plant state, and optional seeded sensor noise. Everything here is
//! simulation-only — a real-hardware backend ignores it. Optional in TOML; omitted fields take
//! the committed defaults.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::clock::{MAX_TIME_SCALE, MIN_TIME_SCALE};
use crate::domain::TimeOfDay;
use crate::validation::{FieldViolation, check_min, check_range};

/// Simulation parameters for the seeded HAL backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Simulation {
    /// Wall-clock tick-cadence multiplier (sim-only). The TOML value is the reset-on-restart
    /// default; it is runtime-adjustable and ephemeral ([HAL §7]). Range 0.25–32×.
    pub time_scale: f64,
    /// PRNG seed — fixes the entire run for reproducible tests (`P1-TEST-2`).
    pub seed: u64,
    /// Default auto-expiry for a sensor-reading injection (simulated seconds); a per-request TTL
    /// overrides it.
    pub sensor_injection_timeout_secs: u64,
    /// Shared simulated wall-clock start (RFC 3339 UTC). `None` → the fixed 2026-01-01 epoch
    /// (deterministic default for tests/standalone). The fleet gen script sets one shared value
    /// (today @ a random whole hour) so every controller's first timestamp and initial time-of-day
    /// agree, then drift as each advances at its own `time_scale`. The clock starts at the
    /// *seconds-of-day* off that day's midnight, so telemetry and time-of-day stay aligned.
    pub start_ts: Option<DateTime<Utc>>,
    /// Solar / PAR day-cycle disturbance.
    pub solar: Solar,
    /// Initial plant state at tick 0.
    pub initial: InitialState,
    /// Seeded per-channel sensor noise (standard deviation). All zero by default.
    pub noise: Noise,
}

impl Default for Simulation {
    fn default() -> Self {
        Simulation {
            time_scale: 1.0,
            seed: 0x5EED_5EED_5EED_5EED,
            sensor_injection_timeout_secs: 300,
            start_ts: None,
            solar: Solar::default(),
            initial: InitialState::default(),
            noise: Noise::default(),
        }
    }
}

impl Simulation {
    /// Append any simulation-tunable violations.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_range(
            violations,
            "simulation.time_scale",
            self.time_scale,
            MIN_TIME_SCALE,
            MAX_TIME_SCALE,
        );
        check_min(
            violations,
            "simulation.sensor_injection_timeout_secs",
            self.sensor_injection_timeout_secs,
            1,
        );
        self.solar.validate(violations);
        self.initial.validate(violations);
        self.noise.validate(violations);
    }
}

/// Solar day cycle: natural PAR (so grow lights *supplement*) and solar heat gain. Modeled as a
/// raised half-sine between `sunrise` and `sunset`, peaking at the window midpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Solar {
    /// Time natural light begins.
    pub sunrise: TimeOfDay,
    /// Time natural light ends. Must be `> sunrise`.
    pub sunset: TimeOfDay,
    /// Peak natural PAR at solar noon (µmol·m⁻²·s⁻¹).
    pub peak_par: f64,
    /// Peak solar contribution to the air-temperature target at solar noon (°C).
    pub peak_heat_gain_c: f64,
}

impl Default for Solar {
    fn default() -> Self {
        Solar {
            sunrise: "06:00".parse().expect("valid HH:MM literal"),
            sunset: "20:00".parse().expect("valid HH:MM literal"),
            peak_par: 800.0,
            peak_heat_gain_c: 6.0,
        }
    }
}

impl Solar {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        if self.sunrise >= self.sunset {
            violations.push(FieldViolation::new(
                "simulation.solar.sunrise",
                "must be < sunset",
                serde_json::json!(self.sunrise.to_string()),
            ));
        }
        check_min(violations, "simulation.solar.peak_par", self.peak_par, 0.0);
        check_min(
            violations,
            "simulation.solar.peak_heat_gain_c",
            self.peak_heat_gain_c,
            0.0,
        );
    }
}

/// The plant state the simulation starts from at tick 0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct InitialState {
    /// Initial air temperature (°C).
    pub temperature_c: f64,
    /// Initial relative humidity (%RH).
    pub humidity_pct: f64,
    /// Initial CO₂ concentration (ppm).
    pub co2_ppm: f64,
    /// Initial per-zone soil moisture (VWC).
    pub soil_moisture: f64,
}

impl Default for InitialState {
    fn default() -> Self {
        InitialState {
            temperature_c: 20.0,
            humidity_pct: 60.0,
            co2_ppm: 420.0,
            soil_moisture: 0.5,
        }
    }
}

impl InitialState {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_range(
            violations,
            "simulation.initial.temperature_c",
            self.temperature_c,
            -20.0,
            60.0,
        );
        check_range(
            violations,
            "simulation.initial.humidity_pct",
            self.humidity_pct,
            0.0,
            100.0,
        );
        check_range(
            violations,
            "simulation.initial.co2_ppm",
            self.co2_ppm,
            0.0,
            20000.0,
        );
        check_range(
            violations,
            "simulation.initial.soil_moisture",
            self.soil_moisture,
            0.0,
            1.0,
        );
    }
}

/// Standard deviations for seeded Gaussian sensor noise, per channel. The small non-zero defaults
/// keep live channels gently jittering (still fully reproducible under the seed) so that a sensor
/// resting at equilibrium is never mistaken for a *stuck* (frozen) one — an injected reading, which
/// overrides noise, is the genuinely-constant case the stuck detector catches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Noise {
    /// Temperature probe noise σ (°C).
    pub temperature_c: f64,
    /// Humidity noise σ (%RH).
    pub humidity_pct: f64,
    /// CO₂ noise σ (ppm).
    pub co2_ppm: f64,
    /// PAR noise σ (µmol·m⁻²·s⁻¹).
    pub par: f64,
    /// Soil-moisture noise σ (VWC).
    pub soil_moisture: f64,
}

impl Default for Noise {
    fn default() -> Self {
        Noise {
            temperature_c: 0.02,
            humidity_pct: 0.1,
            co2_ppm: 1.0,
            par: 1.0,
            soil_moisture: 0.001,
        }
    }
}

impl Noise {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        for (name, value) in [
            ("temperature_c", self.temperature_c),
            ("humidity_pct", self.humidity_pct),
            ("co2_ppm", self.co2_ppm),
            ("par", self.par),
            ("soil_moisture", self.soil_moisture),
        ] {
            check_min(violations, &format!("simulation.noise.{name}"), value, 0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    // Tests deliberately tweak a single field of a valid default to exercise one bound.
    #![allow(clippy::field_reassign_with_default)]

    use super::*;

    #[test]
    fn default_simulation_has_no_violations() {
        let mut v = Vec::new();
        Simulation::default().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn start_ts_defaults_to_none_and_parses_rfc3339() {
        assert_eq!(Simulation::default().start_ts, None);
        let sim: Simulation = toml::from_str("start_ts = \"2026-07-09T14:00:00Z\"").unwrap();
        assert_eq!(
            sim.start_ts,
            Some("2026-07-09T14:00:00Z".parse::<DateTime<Utc>>().unwrap())
        );
    }

    #[test]
    fn out_of_range_time_scale_is_flagged() {
        let mut s = Simulation::default();
        s.time_scale = 64.0;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "simulation.time_scale"));
    }

    #[test]
    fn inverted_solar_window_is_flagged() {
        let mut s = Simulation::default();
        s.solar.sunset = "05:00".parse().unwrap();
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "simulation.solar.sunrise"));
    }

    #[test]
    fn negative_noise_is_flagged() {
        let mut s = Simulation::default();
        s.noise.temperature_c = -0.1;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "simulation.noise.temperature_c")
        );
    }
}
