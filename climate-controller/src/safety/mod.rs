//! The controller's two guardrail layers plus actuator-health monitoring ([safety]).
//!
//! - [`interlocks`] — stage ⑤: unconditional crop-protection overrides (critical temperature, CO₂
//!   ceiling, temperature-unavailable safe hold).
//! - [`constraints`] — stage ⑥: slew/ramp rate limits and anti-short-cycle dwell, shaping whatever
//!   the loops / override / interlocks produced.
//! - [`actuator_health`] — the output-side fault detector (stuck / no-response) that fails an
//!   actuator safe when its commands stop taking effect.
//!
//! The pipeline composes them in priority order ([safety §3]); each only ever *tightens* toward
//! safety.

pub mod actuator_health;
pub mod constraints;
pub mod interlocks;

pub use actuator_health::HealthState;
pub use constraints::ConstraintState;
pub use interlocks::InterlockState;
