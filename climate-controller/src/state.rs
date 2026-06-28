//! The committed post-tick snapshot ([architecture §4]).
//!
//! Each [`Pipeline`](crate::pipeline::Pipeline) tick produces a [`Snapshot`]: the consistent
//! post-tick view (trusted readings, resolved setpoints, commanded + observed actuators, active
//! overrides, faults, mode) that the MQTT publisher and REST `/health` surface will consume in the
//! next slice. The across-tick *state* itself (loop integrators, fault counters, override deadlines)
//! lives in the per-stage modules the pipeline owns; this module owns only the published shape.

use std::collections::BTreeMap;

use crate::control::ResolvedSetpoints;
use crate::faults::{Fault, Mode};
use crate::hal::{ActuatorId, Commands, Observed};
use crate::overrides::Override;
use crate::sensing::TrustedState;

/// The consistent post-tick snapshot of controller state.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The tick this snapshot is for.
    pub tick_index: u64,
    /// Simulated seconds since the clock epoch at this tick — the instant for telemetry `ts`.
    pub sim_seconds: u64,
    /// Conditioned, trusted sensor readings.
    pub trusted: TrustedState,
    /// The setpoints that were active this tick.
    pub resolved: ResolvedSetpoints,
    /// The commanded actuator levels driven to the HAL this tick (post-constraints).
    pub commanded: Commands,
    /// The observed actuator readback after the HAL step.
    pub observed: Observed,
    /// Active manual overrides (actuator → forced value + deadline).
    pub overrides: BTreeMap<ActuatorId, Override>,
    /// All faults active this tick (sensor, interlock, actuator-health, saturation).
    pub faults: Vec<Fault>,
    /// The controller mode derived from the active faults.
    pub mode: Mode,
    /// The day's accumulated Daily Light Integral (mol·m⁻²·d⁻¹) from the lighting loop; resets at
    /// simulated midnight. A derived value (not a sensor reading) carried in the system-state frame.
    pub dli_mol: f64,
}

impl Snapshot {
    /// Whether the controller is fault-free this tick (drives REST `/health.healthy`).
    pub fn healthy(&self) -> bool {
        self.faults.is_empty()
    }
}
