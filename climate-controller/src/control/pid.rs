//! A small PID controller with anti-windup, used by the [temperature loop](super::temperature).
//!
//! The integral term is clamped to `[-integral_clamp, +integral_clamp]` so a long saturated
//! excursion (e.g. while degraded, or with an undersized actuator) cannot accumulate an
//! unrecoverable correction ([control-loops saturation]). Deterministic: output is a pure function
//! of (gains, error history).

/// A stateful PID controller.
#[derive(Debug, Clone)]
pub struct Pid {
    kp: f64,
    ki: f64,
    kd: f64,
    integral_clamp: f64,
    integral: f64,
    prev_error: Option<f64>,
}

impl Pid {
    /// Build a PID from configured gains.
    pub fn from_config(cfg: &crate::config::Pid) -> Self {
        Pid {
            kp: cfg.kp,
            ki: cfg.ki,
            kd: cfg.kd,
            integral_clamp: cfg.integral_clamp,
            integral: 0.0,
            prev_error: None,
        }
    }

    /// Advance one tick with the current `error` over step `dt`, returning the control output.
    pub fn update(&mut self, error: f64, dt: f64) -> f64 {
        self.integral =
            (self.integral + error * dt).clamp(-self.integral_clamp, self.integral_clamp);
        let derivative = match self.prev_error {
            Some(prev) if dt > 0.0 => (error - prev) / dt,
            _ => 0.0,
        };
        self.prev_error = Some(error);
        self.kp * error + self.ki * self.integral + self.kd * derivative
    }

    /// Reset accumulated state — used when the loop suspends (e.g. its input went unavailable) so
    /// no stale correction is dumped on resume.
    pub fn reset(&mut self) {
        self.integral = 0.0;
        self.prev_error = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid() -> Pid {
        Pid::from_config(&crate::config::Pid {
            kp: 2.0,
            ki: 0.5,
            kd: 0.0,
            integral_clamp: 10.0,
        })
    }

    #[test]
    fn proportional_responds_to_error_sign() {
        let mut p = pid();
        assert!(p.update(5.0, 1.0) > 0.0, "positive error → positive output");
        let mut p = pid();
        assert!(
            p.update(-5.0, 1.0) < 0.0,
            "negative error → negative output"
        );
    }

    #[test]
    fn integral_accumulates_then_clamps() {
        let mut p = pid();
        // Drive a constant error; the integral term should grow but never exceed the clamp.
        for _ in 0..1000 {
            p.update(100.0, 1.0);
        }
        assert!((p.integral - 10.0).abs() < 1e-9, "integral clamped at +10");
    }

    #[test]
    fn reset_clears_accumulation() {
        let mut p = pid();
        for _ in 0..10 {
            p.update(5.0, 1.0);
        }
        p.reset();
        // First post-reset output is purely proportional (no integral, no derivative).
        assert!((p.update(1.0, 1.0) - 2.5).abs() < 1e-9, "kp*1 + ki*1*dt");
    }
}
