//! Global climate setpoints (controller spec §4).
//!
//! Bounds mirror `contracts/platform-controller-control-rest/components/schemas/setpoints.json` exactly; the
//! cross-field invariant `humidity_low_pct < humidity_high_pct` is enforced here (the schema
//! cannot express it) and surfaces as a 422 on the REST `PATCH` path.

use serde::{Deserialize, Serialize};

use crate::domain::TimeOfDay;
use crate::validation::{FieldViolation, check_min, check_range};

/// The controller's global climate setpoints. The controller is crop-agnostic: these are
/// numeric targets, never a crop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setpoints {
    /// Daytime air-temperature target (°C).
    pub temperature_day_c: f64,
    /// Nighttime air-temperature target (°C).
    pub temperature_night_c: f64,
    /// Start of the day window (local time-of-day).
    pub day_start: TimeOfDay,
    /// End of the day window (local time-of-day).
    pub day_end: TimeOfDay,
    /// Lower humidity safety bound (%RH). The VPD-derived RH target is clamped to
    /// `[humidity_low_pct, humidity_high_pct]`; this bound also acts as the floor of the
    /// fallback band when the VPD feedforward is unavailable (temperature fault). Must be
    /// `< humidity_high_pct`.
    pub humidity_low_pct: f64,
    /// Upper humidity safety bound (%RH). Clamps the VPD-derived RH target from above and caps
    /// the fallback band. Must be `> humidity_low_pct`.
    pub humidity_high_pct: f64,
    /// Full hysteresis band width around the VPD-derived RH target (%RH): misters turn on below
    /// `target − width/2` and off above `target + width/2`.
    pub humidity_deadband_pct: f64,
    /// CO₂ enrichment target; injector opens below this, closes when reached (ppm).
    pub co2_target_ppm: u32,
    /// Vent position above which the CO₂ injector is hard-interlocked off (% open).
    pub co2_vent_interlock_threshold_pct: f64,
    /// Primary humidity control input: the vapor-pressure-deficit target (kPa). Each tick the
    /// humidity loop derives its RH target by inverting VPD at the fused air temperature, then
    /// clamps it to the humidity safety bounds.
    pub vpd_target_kpa: f64,
    /// Daily Light Integral target driving supplemental lighting (mol·m⁻²·day⁻¹).
    pub dli_target_mol: f64,
    /// Expected clear-sky peak natural PAR at solar noon (µmol·m⁻²·s⁻¹), used to *predict* how much
    /// natural DLI is still coming before `day_end` so supplemental grow lights cover only the
    /// shortfall the sun won't provide (and turn off early on bright days). A controller-side
    /// operator estimate — independent of, and never read from, the simulator's hidden
    /// `[simulation.solar]`. `0` disables the prediction: lights fall back to purely reactive
    /// (on whenever behind the target during the day window). Optional; defaults to `0`.
    #[serde(default)]
    pub expected_peak_par: f64,
}

impl Setpoints {
    /// Append any bound or invariant violations. The bounds match the REST contract so this
    /// same routine validates a runtime `PATCH` later.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_range(
            violations,
            "temperature_day_c",
            self.temperature_day_c,
            -20.0,
            60.0,
        );
        check_range(
            violations,
            "temperature_night_c",
            self.temperature_night_c,
            -20.0,
            60.0,
        );
        check_range(
            violations,
            "humidity_low_pct",
            self.humidity_low_pct,
            0.0,
            100.0,
        );
        check_range(
            violations,
            "humidity_high_pct",
            self.humidity_high_pct,
            0.0,
            100.0,
        );
        check_range(
            violations,
            "humidity_deadband_pct",
            self.humidity_deadband_pct,
            0.0,
            50.0,
        );
        check_range(violations, "co2_target_ppm", self.co2_target_ppm, 0, 5000);
        check_range(
            violations,
            "co2_vent_interlock_threshold_pct",
            self.co2_vent_interlock_threshold_pct,
            0.0,
            100.0,
        );
        check_min(violations, "vpd_target_kpa", self.vpd_target_kpa, 0.0);
        check_min(violations, "dli_target_mol", self.dli_target_mol, 0.0);
        check_min(violations, "expected_peak_par", self.expected_peak_par, 0.0);

        // Cross-field invariants the JSON Schema can't express (controller-enforced 422).
        if self.humidity_low_pct >= self.humidity_high_pct {
            violations.push(FieldViolation::new(
                "humidity_low_pct",
                "must be < humidity_high_pct",
                serde_json::json!(self.humidity_low_pct),
            ));
        }
        if self.day_start >= self.day_end {
            violations.push(FieldViolation::new(
                "day_start",
                "must be < day_end",
                serde_json::json!(self.day_start.to_string()),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Setpoints {
        Setpoints {
            temperature_day_c: 24.0,
            temperature_night_c: 18.0,
            day_start: "06:00".parse().unwrap(),
            day_end: "20:00".parse().unwrap(),
            humidity_low_pct: 65.0,
            humidity_high_pct: 75.0,
            humidity_deadband_pct: 5.0,
            co2_target_ppm: 1000,
            co2_vent_interlock_threshold_pct: 15.0,
            vpd_target_kpa: 1.0,
            dli_target_mol: 20.0,
            expected_peak_par: 800.0,
        }
    }

    #[test]
    fn valid_setpoints_have_no_violations() {
        let mut v = Vec::new();
        valid().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn out_of_range_humidity_is_flagged() {
        let mut s = valid();
        s.humidity_high_pct = 150.0;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "humidity_high_pct" && x.bound == "0..=100")
        );
    }

    #[test]
    fn inverted_humidity_band_is_flagged() {
        let mut s = valid();
        s.humidity_low_pct = 80.0; // now >= high (75)
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "humidity_low_pct" && x.bound == "must be < humidity_high_pct")
        );
    }

    #[test]
    fn out_of_range_humidity_deadband_is_flagged() {
        let mut s = valid();
        s.humidity_deadband_pct = 60.0; // above the 50 %RH cap
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "humidity_deadband_pct" && x.bound == "0..=50")
        );
    }

    #[test]
    fn negative_expected_peak_par_is_flagged() {
        let mut s = valid();
        s.expected_peak_par = -1.0; // a clear-sky peak can't be negative
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "expected_peak_par"));
    }
}
