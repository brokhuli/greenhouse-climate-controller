//! Faults, severities, and the controller mode — the vocabulary every stage uses to surface a
//! problem ([sensing §6], [safety §2/§5], [control-loops saturation]).
//!
//! The enums mirror the closed `fault_type` / `severity` enums in the MQTT fault-event contract
//! (`contracts/mqtt/fault-event.schema.json`) so the controller's internal vocabulary cannot drift
//! from what it will publish. A [`Fault`] is produced fresh each tick from live state (faults are
//! "sticky" only in that the *condition* persists, so re-detection re-raises them); the
//! [`Mode`] summarizes the worst active fault for the `/health` surface.

use serde::{Deserialize, Serialize};

use crate::domain::Slug;

/// Why a fault was raised. Variant names match the MQTT `fault_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultType {
    /// A sensor reading is frozen.
    Stuck,
    /// A sensor reading is outside physical plausibility.
    OutOfRange,
    /// A temperature probe deviates from the others.
    SensorDisagreement,
    /// Running on reduced temperature redundancy (down to one trustworthy probe).
    RedundancyDegraded,
    /// No two temperature probes agree — temperature is untrusted.
    TemperatureUnavailable,
    /// Air temperature has crossed the critical-max interlock threshold.
    CriticalTemperature,
    /// CO₂ has crossed the safety-ceiling interlock threshold.
    Co2Ceiling,
    /// An irrigation valve opened but soil moisture did not respond.
    IrrigationNoResponse,
    /// An actuator's observed state diverges from its command.
    ActuatorStuck,
    /// An actuator obeys but produces no climate effect.
    ActuatorNoResponse,
    /// A loop is pinned at its limit and cannot reach its setpoint.
    SetpointUnreachable,
}

impl FaultType {
    /// Whether this fault represents a safety interlock holding a protective state ([safety §2]).
    /// These drive the controller into [`Mode::Interlock`].
    pub fn is_interlock(self) -> bool {
        matches!(
            self,
            FaultType::CriticalTemperature
                | FaultType::Co2Ceiling
                | FaultType::TemperatureUnavailable
                | FaultType::IrrigationNoResponse
        )
    }
}

/// Fault severity. `Warning` = degraded but operating; `Alarm` = a safety/interlock/loss-of-trust
/// condition. Matches the MQTT `severity` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Degraded but still operating.
    Warning,
    /// A safety/interlock or loss-of-trust condition.
    Alarm,
}

/// One active fault. `component` is the affected sensor/actuator/loop (e.g. `"temperature"`,
/// `"co2_injector"`); `zone_id` scopes per-zone faults; `response` records the fail-safe action
/// taken. Serializes toward the MQTT fault-event shape (the wire envelope is added at publish time).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fault {
    /// The affected component (sensor, actuator, or loop).
    pub component: String,
    /// The zone this fault is scoped to, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone_id: Option<Slug>,
    /// Why the fault was raised.
    pub fault_type: FaultType,
    /// How severe it is.
    pub severity: Severity,
    /// Human-readable description.
    pub message: String,
    /// The fail-safe action the controller took in response.
    pub response: String,
}

impl Fault {
    /// Build a greenhouse-scoped (non-zone) fault.
    pub fn new(
        component: impl Into<String>,
        fault_type: FaultType,
        severity: Severity,
        message: impl Into<String>,
        response: impl Into<String>,
    ) -> Self {
        Fault {
            component: component.into(),
            zone_id: None,
            fault_type,
            severity,
            message: message.into(),
            response: response.into(),
        }
    }

    /// Scope this fault to a zone (builder style).
    pub fn in_zone(mut self, zone: Slug) -> Self {
        self.zone_id = Some(zone);
        self
    }
}

/// The controller's operating mode, derived from the worst active fault for the `/health` surface
/// ([interfaces §5]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// All nominal.
    Normal,
    /// A non-critical fault is active; still controlling.
    Degraded,
    /// A safety interlock is holding a protective state.
    Interlock,
}

impl Mode {
    /// The mode implied by the set of active faults: interlock if any interlock fault is present,
    /// else degraded if any fault is present, else normal.
    pub fn from_faults(faults: &[Fault]) -> Mode {
        if faults.iter().any(|f| f.fault_type.is_interlock()) {
            Mode::Interlock
        } else if !faults.is_empty() {
            Mode::Degraded
        } else {
            Mode::Normal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_reflects_worst_fault() {
        assert_eq!(Mode::from_faults(&[]), Mode::Normal);
        let warn = Fault::new(
            "humidity",
            FaultType::OutOfRange,
            Severity::Alarm,
            "out of range",
            "disabled misters",
        );
        assert_eq!(
            Mode::from_faults(std::slice::from_ref(&warn)),
            Mode::Degraded
        );
        let interlock = Fault::new(
            "temperature",
            FaultType::CriticalTemperature,
            Severity::Alarm,
            "critical",
            "full cooling",
        );
        assert_eq!(Mode::from_faults(&[warn, interlock]), Mode::Interlock);
    }

    #[test]
    fn fault_serializes_with_optional_zone() {
        let f = Fault::new(
            "soil_moisture",
            FaultType::OutOfRange,
            Severity::Alarm,
            "oor",
            "disabled zone",
        )
        .in_zone("bench-a".parse().unwrap());
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["fault_type"], "out_of_range");
        assert_eq!(json["severity"], "alarm");
        assert_eq!(json["zone_id"], "bench-a");
    }
}
