//! Control-loop tunables (`[control]`, controller spec §5, §7).
//!
//! Gains and the saturation window the [control loops](../control) read. The section is
//! optional in TOML: a config that omits `[control]` gets the committed defaults from the
//! [default-parameters reference](../../../../docs/specs/design/controller/07-spec-controller-config-and-parameters.md),
//! so existing configs keep loading unchanged.

use serde::{Deserialize, Serialize};

use crate::validation::{FieldViolation, check_min};

/// Control-loop parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Control {
    /// Gains for the temperature PID loop.
    pub temperature_pid: Pid,
    /// Sustained-saturation window before `setpoint_unreachable` is raised (simulated seconds).
    pub saturation_window_secs: u64,
}

impl Default for Control {
    fn default() -> Self {
        Control {
            temperature_pid: Pid::default(),
            saturation_window_secs: 300,
        }
    }
}

impl Control {
    /// Append any control-tunable violations.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        self.temperature_pid.validate(violations);
        check_min(
            violations,
            "control.saturation_window_secs",
            self.saturation_window_secs,
            1,
        );
    }
}

/// PID gains with an anti-windup clamp on the accumulated integral term.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Pid {
    /// Proportional gain.
    pub kp: f64,
    /// Integral gain.
    pub ki: f64,
    /// Derivative gain.
    pub kd: f64,
    /// Magnitude bound on the integral term (anti-windup): the integrator is clamped to
    /// `[-integral_clamp, +integral_clamp]` so a long saturated excursion cannot accumulate an
    /// unrecoverable correction (control-loops "saturation").
    pub integral_clamp: f64,
}

impl Default for Pid {
    fn default() -> Self {
        Pid {
            kp: 18.0,
            ki: 0.5,
            kd: 0.0,
            integral_clamp: 100.0,
        }
    }
}

impl Pid {
    fn validate(&self, violations: &mut Vec<FieldViolation>) {
        check_min(violations, "control.temperature_pid.kp", self.kp, 0.0);
        check_min(violations, "control.temperature_pid.ki", self.ki, 0.0);
        check_min(violations, "control.temperature_pid.kd", self.kd, 0.0);
        check_min(
            violations,
            "control.temperature_pid.integral_clamp",
            self.integral_clamp,
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
    fn default_control_has_no_violations() {
        let mut v = Vec::new();
        Control::default().validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn negative_gain_is_flagged() {
        let mut c = Control::default();
        c.temperature_pid.kp = -1.0;
        let mut v = Vec::new();
        c.validate(&mut v);
        assert!(v.iter().any(|x| x.field == "control.temperature_pid.kp"));
    }

    #[test]
    fn zero_saturation_window_is_flagged() {
        let mut c = Control::default();
        c.saturation_window_secs = 0;
        let mut v = Vec::new();
        c.validate(&mut v);
        assert!(
            v.iter()
                .any(|x| x.field == "control.saturation_window_secs")
        );
    }
}
