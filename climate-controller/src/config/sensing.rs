//! Sensing / fault-detection tunables (`[sensing]`, controller spec §4, §6 §5).
//!
//! Probe redundancy, plausibility bounds, and the detection windows used by
//! [sensing](../sensing) (input faults) and [actuator health](../safety) (output faults).
//! Optional in TOML; omitted fields take the committed defaults.

use serde::{Deserialize, Serialize};

use crate::validation::{FieldViolation, check_min};

/// Sensing and fault-detection parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sensing {
    /// Number of redundant temperature probes fused by median voting (TMR default 3, `P1-REL-2`).
    pub probe_count: usize,
    /// A probe deviating from the median by more than this is excluded (°C).
    pub probe_disagreement_c: f64,
    /// A reading unchanged for longer than this is flagged stuck (simulated seconds, `P1-REL-3`).
    pub stuck_window_secs: u64,
    /// Humidity plausibility bounds (%RH); a reading outside is out-of-range.
    pub humidity_bounds: Bounds,
    /// CO₂ plausibility bounds (ppm).
    pub co2_bounds: Bounds,
    /// PAR plausibility bounds (µmol·m⁻²·s⁻¹).
    pub par_bounds: Bounds,
    /// Soil-moisture plausibility bounds (VWC).
    pub soil_moisture_bounds: Bounds,
    /// Commanded-vs-observed divergence beyond which an actuator is flagged stuck (% / level).
    pub commanded_vs_observed_tol: f64,
    /// Ticks a commanded change may produce no climate response before no-response fires
    /// (`P1-REL-4`).
    pub no_response_window_ticks: u64,
}

impl Default for Sensing {
    fn default() -> Self {
        Sensing {
            probe_count: 3,
            probe_disagreement_c: 2.0,
            stuck_window_secs: 5,
            humidity_bounds: Bounds::new(0.0, 100.0),
            co2_bounds: Bounds::new(200.0, 5000.0),
            par_bounds: Bounds::new(0.0, 2500.0),
            soil_moisture_bounds: Bounds::new(0.0, 1.0),
            commanded_vs_observed_tol: 5.0,
            no_response_window_ticks: 5,
        }
    }
}

impl Sensing {
    /// Append any sensing-tunable violations.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_min(violations, "sensing.probe_count", self.probe_count, 1);
        check_min(
            violations,
            "sensing.probe_disagreement_c",
            self.probe_disagreement_c,
            0.0,
        );
        check_min(
            violations,
            "sensing.stuck_window_secs",
            self.stuck_window_secs,
            1,
        );
        self.humidity_bounds
            .validate("sensing.humidity_bounds", violations);
        self.co2_bounds.validate("sensing.co2_bounds", violations);
        self.par_bounds.validate("sensing.par_bounds", violations);
        self.soil_moisture_bounds
            .validate("sensing.soil_moisture_bounds", violations);
        check_min(
            violations,
            "sensing.commanded_vs_observed_tol",
            self.commanded_vs_observed_tol,
            0.0,
        );
        check_min(
            violations,
            "sensing.no_response_window_ticks",
            self.no_response_window_ticks,
            1,
        );
    }
}

/// An inclusive plausibility interval `[min, max]`. A reading outside it is out-of-range.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    /// Lower bound (inclusive).
    pub min: f64,
    /// Upper bound (inclusive). Must be `> min`.
    pub max: f64,
}

impl Bounds {
    /// Construct a bounds pair.
    pub fn new(min: f64, max: f64) -> Self {
        Bounds { min, max }
    }

    /// Whether `value` lies within `[min, max]` inclusive.
    pub fn contains(&self, value: f64) -> bool {
        value >= self.min && value <= self.max
    }

    fn validate(&self, field: &str, violations: &mut Vec<FieldViolation>) {
        if self.min >= self.max {
            violations.push(FieldViolation::new(
                format!("{field}.min"),
                "must be < max",
                serde_json::json!(self.min),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    // Tests deliberately tweak a single field of a valid default to exercise one bound.
    #![allow(clippy::field_reassign_with_default)]

    use super::*;

    #[test]
    fn default_sensing_has_no_violations() {
        let mut v = Vec::new();
        Sensing::default().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn zero_probe_count_is_flagged() {
        let mut s = Sensing::default();
        s.probe_count = 0;
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "sensing.probe_count"));
    }

    #[test]
    fn inverted_bounds_are_flagged() {
        let mut s = Sensing::default();
        s.co2_bounds = Bounds::new(5000.0, 200.0);
        let mut v = Vec::new();
        s.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "sensing.co2_bounds.min" && x.bound == "must be < max")
        );
    }

    #[test]
    fn bounds_contains_is_inclusive() {
        let b = Bounds::new(0.0, 100.0);
        assert!(b.contains(0.0));
        assert!(b.contains(100.0));
        assert!(!b.contains(-0.1));
        assert!(!b.contains(100.1));
    }
}
