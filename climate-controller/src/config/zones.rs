//! Per-zone irrigation configuration (controller spec §4, §6).
//!
//! Bounds mirror `contracts/controller-rest/components/schemas/zones.json`; the cross-field
//! invariant `moisture_low_threshold < moisture_high_threshold` is controller-enforced.

use serde::{Deserialize, Serialize};

use crate::domain::{Schedule, Slug};
use crate::validation::{FieldViolation, check_range};

/// One irrigation zone. The scheduler runs one independent loop per zone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Zone {
    /// Zone identity (lowercase kebab slug), e.g. `bench-a`.
    pub id: Slug,
    /// Irrigation triggers below this soil moisture (VWC, 0–1).
    pub moisture_low_threshold: f64,
    /// Irrigation stops above this soil moisture (VWC, 0–1). Must be `> moisture_low_threshold`.
    pub moisture_high_threshold: f64,
    /// Minimum gap between irrigation cycles, to prevent root saturation (seconds).
    pub drain_period_secs: u64,
    /// Time-of-day irrigation triggers.
    pub schedule: Schedule,
}

impl Zone {
    /// Append any bound or invariant violations for this zone. Field paths are prefixed with
    /// the zone id so a multi-zone config points at the offending zone.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        let field = |name: &str| format!("zones.{}.{}", self.id, name);
        check_range(
            violations,
            &field("moisture_low_threshold"),
            self.moisture_low_threshold,
            0.0,
            1.0,
        );
        check_range(
            violations,
            &field("moisture_high_threshold"),
            self.moisture_high_threshold,
            0.0,
            1.0,
        );
        // drain_period_secs is u64 (>= 0 inherently); the contract sets no upper bound.

        if self.moisture_low_threshold >= self.moisture_high_threshold {
            violations.push(FieldViolation::new(
                field("moisture_low_threshold"),
                "must be < moisture_high_threshold",
                serde_json::json!(self.moisture_low_threshold),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Zone {
        Zone {
            id: "bench-a".parse().unwrap(),
            moisture_low_threshold: 0.35,
            moisture_high_threshold: 0.55,
            drain_period_secs: 300,
            schedule: "06:00,14:00".parse().unwrap(),
        }
    }

    #[test]
    fn valid_zone_has_no_violations() {
        let mut v = Vec::new();
        valid().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn moisture_out_of_range_is_flagged() {
        let mut z = valid();
        z.moisture_high_threshold = 1.5;
        let mut v = Vec::new();
        z.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "zones.bench-a.moisture_high_threshold" && x.bound == "0..=1")
        );
    }

    #[test]
    fn inverted_moisture_band_is_flagged() {
        let mut z = valid();
        z.moisture_low_threshold = 0.60; // now >= high (0.55)
        let mut v = Vec::new();
        z.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.bound == "must be < moisture_high_threshold")
        );
    }
}
