//! HAL simulation parameters (controller spec §3, §9).
//!
//! The coupling matrix models each actuator as producing a **set of effects on climate
//! variables**, never a one-to-one actuator→variable mapping (RFC-006). The existing actuators
//! each happen to affect mostly one variable, but the shape does not encode that as an
//! invariant — which is what lets the Phase 4 combustion heater land as a new HAL backend
//! rather than a rewrite.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::domain::{Actuator, ClimateVariable};
use crate::validation::FieldViolation;

/// The full HAL simulation model: dynamics, hidden disturbances, and the actuator coupling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hal {
    /// Per-variable first-order-lag time constants.
    pub time_constants: TimeConstants,
    /// Hidden disturbances the controller cannot see (drives the load it fights).
    pub disturbances: Disturbances,
    /// The coupling matrix: each actuator's set of effects plus its hardware constraints.
    pub actuators: Vec<ActuatorModel>,
}

impl Hal {
    /// Append any HAL-config violations (positive time constants, finite gains, one model per
    /// actuator, at least one effect per actuator).
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        self.time_constants.validate(violations);

        let mut seen = HashSet::new();
        for (i, model) in self.actuators.iter().enumerate() {
            if !seen.insert(model.actuator) {
                violations.push(FieldViolation::new(
                    format!("hal.actuators[{i}].actuator"),
                    "each actuator may be modeled at most once",
                    serde_json::to_value(model.actuator).unwrap_or(serde_json::Value::Null),
                ));
            }
            if model.effects.is_empty() {
                violations.push(FieldViolation::new(
                    format!("hal.actuators[{i}].effects"),
                    "must declare at least one effect",
                    serde_json::Value::Null,
                ));
            }
            for (j, effect) in model.effects.iter().enumerate() {
                if !effect.gain.is_finite() {
                    violations.push(FieldViolation::new(
                        format!("hal.actuators[{i}].effects[{j}].gain"),
                        "must be finite",
                        serde_json::json!(effect.gain),
                    ));
                }
            }
        }
    }
}

/// Per-variable time constants (τ) for the coupled first-order lag, in seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeConstants {
    /// Air temperature τ (s).
    pub temperature_s: f64,
    /// Humidity τ (s).
    pub humidity_s: f64,
    /// CO₂ τ (s).
    pub co2_s: f64,
    /// PAR τ (s).
    pub par_s: f64,
    /// Soil moisture τ (s).
    pub soil_moisture_s: f64,
}

impl TimeConstants {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        // τ must be strictly positive: a zero time constant is a division-by-zero in the lag model.
        for (name, value) in [
            ("temperature_s", self.temperature_s),
            ("humidity_s", self.humidity_s),
            ("co2_s", self.co2_s),
            ("par_s", self.par_s),
            ("soil_moisture_s", self.soil_moisture_s),
        ] {
            // τ must be strictly positive and finite.
            if value <= 0.0 || !value.is_finite() {
                violations.push(FieldViolation::new(
                    format!("hal.time_constants.{name}"),
                    "> 0",
                    serde_json::json!(value),
                ));
            }
        }
    }
}

/// Hidden disturbance model (controller spec §3). The controller never reads these directly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disturbances {
    /// Outdoor air temperature driving heat loss/gain (°C).
    pub outdoor_temp_c: f64,
    /// Ambient outside humidity the greenhouse drifts toward (%RH).
    pub ambient_humidity_pct: f64,
    /// Heat-loss coefficient to the outside (fraction per second).
    pub heat_loss_coeff: f64,
    /// Plant CO₂ uptake during light hours (ppm per second).
    pub plant_co2_uptake_ppm_per_s: f64,
    /// Per-zone soil drying rate (VWC per second).
    pub soil_drying_rate_per_s: f64,
}

/// One actuator's entry in the coupling matrix: its effect set and hardware constraints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActuatorModel {
    /// Which actuator this models.
    pub actuator: Actuator,
    /// The set of climate variables this actuator affects (never assumed to be one).
    pub effects: Vec<Effect>,
    /// Hardware constraints (slew/ramp/min-cycle). Defaults to unconstrained.
    #[serde(default)]
    pub constraints: Constraints,
}

/// A single actuator→variable coupling: a gain applied to the target of that variable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Effect {
    /// The affected climate variable.
    pub variable: ClimateVariable,
    /// Signed influence on that variable's target (units are the HAL's; tuned during impl).
    pub gain: f64,
}

/// Hardware constraints applied between control output and the HAL (controller spec §9). All
/// fields are optional — an actuator declares only the constraints that apply to it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Constraints {
    /// Maximum position slew rate (% per second) — for vents / shade screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slew_pct_per_s: Option<f64>,
    /// Minimum on-time, anti short-cycle (s) — for heater / CO₂ injector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_on_secs: Option<u64>,
    /// Minimum off-time, anti short-cycle (s) — for heater / CO₂ injector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_off_secs: Option<u64>,
    /// Speed ramp-rate limit (% per second) — for fans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ramp_pct_per_s: Option<f64>,
    /// Minimum open time, ensures meaningful delivery (s) — for irrigation valves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_open_secs: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time_constants() -> TimeConstants {
        TimeConstants {
            temperature_s: 120.0,
            humidity_s: 60.0,
            co2_s: 30.0,
            par_s: 10.0,
            soil_moisture_s: 1800.0,
        }
    }

    fn disturbances() -> Disturbances {
        Disturbances {
            outdoor_temp_c: 10.0,
            ambient_humidity_pct: 50.0,
            heat_loss_coeff: 0.02,
            plant_co2_uptake_ppm_per_s: 0.5,
            soil_drying_rate_per_s: 0.00001,
        }
    }

    fn heater() -> ActuatorModel {
        ActuatorModel {
            actuator: Actuator::Heater,
            effects: vec![Effect {
                variable: ClimateVariable::Temperature,
                gain: 0.05,
            }],
            constraints: Constraints {
                min_on_secs: Some(60),
                min_off_secs: Some(60),
                ..Constraints::default()
            },
        }
    }

    #[test]
    fn valid_hal_has_no_violations() {
        let hal = Hal {
            time_constants: time_constants(),
            disturbances: disturbances(),
            actuators: vec![heater()],
        };
        let mut v = Vec::new();
        hal.validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn zero_time_constant_is_flagged() {
        let mut tc = time_constants();
        tc.temperature_s = 0.0;
        let mut v = Vec::new();
        tc.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "hal.time_constants.temperature_s")
        );
    }

    #[test]
    fn duplicate_actuator_and_empty_effects_are_flagged() {
        let mut empty = heater();
        empty.actuator = Actuator::Fans;
        empty.effects.clear();
        let hal = Hal {
            time_constants: time_constants(),
            disturbances: disturbances(),
            actuators: vec![heater(), heater(), empty],
        };
        let mut v = Vec::new();
        hal.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.bound == "each actuator may be modeled at most once")
        );
        assert!(
            v.iter()
                .any(|x| x.bound == "must declare at least one effect")
        );
    }
}
