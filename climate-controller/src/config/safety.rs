//! Safety-interlock and manual-override tunables (`[safety]`, controller spec §6).
//!
//! The thresholds that decide *when* an interlock fires and clears, and how long a forgotten
//! manual override survives. The fail-safe *responses* themselves are not tunable — they live
//! in the [safety](../safety) modules. Optional in TOML; omitted fields take the committed
//! defaults.

use serde::{Deserialize, Serialize};

use crate::validation::{FieldViolation, check_min, check_range};

/// Safety thresholds and the manual-override auto-expiry timeout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Safety {
    /// Air temperature above which the critical-temperature interlock asserts (°C).
    pub critical_temperature_c: f64,
    /// CO₂ concentration above which the CO₂-ceiling interlock asserts (ppm).
    pub co2_ceiling_ppm: u32,
    /// Margin a reading must recover *past* (below the threshold) before an interlock clears.
    pub interlock_rearm_hysteresis: RearmHysteresis,
    /// Minimum dwell an interlock stays asserted before it may clear (simulated seconds).
    pub interlock_min_hold_secs: u64,
    /// Auto-expiry for a manual override, so a forgotten override cannot strand the greenhouse
    /// (`P1-RESIL-2`); simulated seconds.
    pub override_timeout_secs: u64,
}

impl Default for Safety {
    fn default() -> Self {
        Safety {
            critical_temperature_c: 40.0,
            co2_ceiling_ppm: 5000,
            interlock_rearm_hysteresis: RearmHysteresis::default(),
            interlock_min_hold_secs: 60,
            override_timeout_secs: 1800,
        }
    }
}

impl Safety {
    /// Append any safety-tunable violations.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_range(
            violations,
            "safety.critical_temperature_c",
            self.critical_temperature_c,
            -20.0,
            80.0,
        );
        check_range(
            violations,
            "safety.co2_ceiling_ppm",
            self.co2_ceiling_ppm,
            0,
            20000,
        );
        self.interlock_rearm_hysteresis.validate(violations);
        check_min(
            violations,
            "safety.interlock_min_hold_secs",
            self.interlock_min_hold_secs,
            0,
        );
        check_min(
            violations,
            "safety.override_timeout_secs",
            self.override_timeout_secs,
            1,
        );
    }
}

/// Per-quantity re-arm margins for interlock clearing ([safety §2 assert-and-clear]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RearmHysteresis {
    /// Temperature must fall this far below `critical_temperature_c` before the interlock clears (°C).
    pub temperature_c: f64,
    /// CO₂ must fall this far below `co2_ceiling_ppm` before the interlock clears (ppm).
    pub co2_ppm: f64,
}

impl Default for RearmHysteresis {
    fn default() -> Self {
        RearmHysteresis {
            temperature_c: 2.0,
            co2_ppm: 200.0,
        }
    }
}

impl RearmHysteresis {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_min(
            violations,
            "safety.interlock_rearm_hysteresis.temperature_c",
            self.temperature_c,
            0.0,
        );
        check_min(
            violations,
            "safety.interlock_rearm_hysteresis.co2_ppm",
            self.co2_ppm,
            0.0,
        );
    }
}

#[cfg(test)]
mod tests {
    // Tests deliberately tweak a single field of a valid default to exercise one bound.
    #![allow(clippy::field_reassign_with_default)]

    use super::*;

    #[test]
    fn default_safety_has_no_violations() {
        let mut v = Vec::new();
        Safety::default().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn out_of_range_critical_temp_is_flagged() {
        let mut s = Safety::default();
        s.critical_temperature_c = 200.0;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "safety.critical_temperature_c"));
    }

    #[test]
    fn zero_override_timeout_is_flagged() {
        let mut s = Safety::default();
        s.override_timeout_secs = 0;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "safety.override_timeout_secs"));
    }
}
