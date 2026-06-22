//! MQTT telemetry wire types and frame builders ([interfaces §2], `contracts/mqtt/`).
//!
//! Maps a committed [`Snapshot`] to the published frames: per-metric sensor readings, per-actuator
//! state, fault events, and the retained consolidated system-state snapshot. Each frame carries the
//! RFC-007 envelope (`schema_version`, `greenhouse_id`, `zone_id`, `ts`); `ts` is the **simulated**
//! instant (envelope `ts` = epoch + `sim_seconds`), so observers plot on simulated time. The wire
//! shapes mirror `contracts/mqtt/*.schema.json` exactly so what the controller publishes cannot
//! drift from the contract.

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::Serialize;

use crate::domain::Actuator;
use crate::faults::{Fault, FaultType, Mode, Severity};
use crate::hal::{ActuatorId, HOUSE_ACTUATORS};
use crate::state::Snapshot;

/// Current major version of the MQTT message schemas (RFC-007).
const SCHEMA_VERSION: u32 = 1;

/// A ready-to-send MQTT frame.
#[derive(Debug, Clone)]
pub struct PublishFrame {
    /// MQTT topic.
    pub topic: String,
    /// JSON payload.
    pub payload: Vec<u8>,
    /// Whether to publish retained (only the consolidated system-state is retained).
    pub retain: bool,
}

/// The fixed simulated-clock epoch: `sim_seconds` are measured from this instant.
pub fn epoch() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0)
        .single()
        .expect("valid epoch")
}

/// RFC 3339 UTC, millisecond precision, from a simulated-seconds offset off the epoch.
fn ts(base: DateTime<Utc>, sim_seconds: u64) -> String {
    (base + Duration::seconds(sim_seconds as i64))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Public RFC 3339 UTC timestamp from a simulated-seconds offset (used by the REST surface for
/// `created_at` / `expires_at` / `updated_at`, so REST and MQTT share one clock representation).
pub fn instant_ts(base: DateTime<Utc>, sim_seconds: u64) -> String {
    ts(base, sim_seconds)
}

/// The actuator's MQTT/REST enum name.
pub fn actuator_name(actuator: Actuator) -> &'static str {
    match actuator {
        Actuator::Heater => "heater",
        Actuator::Fans => "fans",
        Actuator::RoofVents => "roof_vents",
        Actuator::Misters => "misters",
        Actuator::Co2Injector => "co2_injector",
        Actuator::GrowLights => "grow_lights",
        Actuator::ShadeScreen => "shade_screen",
        Actuator::IrrigationValve => "irrigation_valve",
    }
}

/// Pure on/off devices report `level_pct: null`; variable/modulating ones report 0–100.
pub fn is_on_off(actuator: Actuator) -> bool {
    matches!(
        actuator,
        Actuator::Misters | Actuator::Co2Injector | Actuator::IrrigationValve
    )
}

/// The unified `{on, level_pct}` output shape (mirrors `actuator-state.schema.json#/$defs/state`),
/// used for both telemetry output and REST override request/response bodies.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct OutputState {
    /// Whether the actuator is energized / open.
    pub on: bool,
    /// Output level 0–100 for variable actuators; null for pure on/off devices.
    pub level_pct: Option<f64>,
}

impl OutputState {
    /// Build from an actuator kind and its commanded/observed level.
    pub fn new(actuator: Actuator, level: f64) -> Self {
        OutputState {
            on: level > 0.0,
            level_pct: if is_on_off(actuator) {
                None
            } else {
                Some(level)
            },
        }
    }
}

/// The actuator-health monitor verdict for an actuator, derived from the active faults.
fn health_str(name: &str, faults: &[Fault]) -> &'static str {
    let mut verdict = "ok";
    for f in faults.iter().filter(|f| f.component == name) {
        match f.fault_type {
            FaultType::ActuatorStuck => return "stuck",
            FaultType::ActuatorNoResponse | FaultType::IrrigationNoResponse => {
                verdict = "no_response"
            }
            _ => {}
        }
    }
    verdict
}

#[derive(Serialize)]
struct SensorReadingMsg<'a> {
    schema_version: u32,
    greenhouse_id: &'a str,
    zone_id: Option<&'a str>,
    ts: &'a str,
    metric: &'static str,
    value: f64,
    unit: &'static str,
}

#[derive(Serialize)]
struct ActuatorStateMsg<'a> {
    schema_version: u32,
    greenhouse_id: &'a str,
    zone_id: Option<&'a str>,
    ts: &'a str,
    actuator: &'static str,
    commanded: OutputState,
    observed: OutputState,
    health: &'static str,
    overridden: bool,
}

#[derive(Serialize)]
struct FaultEventMsg<'a> {
    schema_version: u32,
    greenhouse_id: &'a str,
    zone_id: Option<String>,
    ts: &'a str,
    component: &'a str,
    fault_type: FaultType,
    severity: Severity,
    message: &'a str,
    response: &'a str,
}

#[derive(Serialize)]
struct ReadingVu {
    value: f64,
    unit: &'static str,
}

#[derive(Serialize)]
struct Sensors {
    temperature: Option<ReadingVu>,
    humidity: Option<ReadingVu>,
    co2: Option<ReadingVu>,
    par: Option<ReadingVu>,
    vpd: Option<ReadingVu>,
}

#[derive(Serialize)]
struct Controller {
    mode: Mode,
    healthy: bool,
}

#[derive(Serialize)]
struct ZoneEntry {
    zone_id: String,
    soil_moisture: Option<ReadingVu>,
    irrigation: OutputState,
    faulted: bool,
}

#[derive(Serialize)]
struct ActuatorEntry {
    actuator: &'static str,
    commanded: OutputState,
    observed: OutputState,
    health: &'static str,
    overridden: bool,
}

#[derive(Serialize)]
struct FaultSummary {
    component: String,
    zone_id: Option<String>,
    fault_type: FaultType,
    severity: Severity,
}

#[derive(Serialize)]
struct OverrideEntry {
    actuator: &'static str,
    zone_id: Option<String>,
    state: OutputState,
    expires_at: Option<String>,
}

#[derive(Serialize)]
struct SimulationBlock {
    time_scale: f64,
    tick_index: u64,
}

#[derive(Serialize)]
struct SystemStateMsg<'a> {
    schema_version: u32,
    greenhouse_id: &'a str,
    zone_id: Option<&'a str>,
    ts: &'a str,
    controller: Controller,
    sensors: Sensors,
    zones: Vec<ZoneEntry>,
    actuators: Vec<ActuatorEntry>,
    faults: Vec<FaultSummary>,
    overrides: Vec<OverrideEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    simulation: Option<SimulationBlock>,
}

/// Identity of an active fault for edge-triggered publishing: `(component, zone_id, fault_type)`.
/// A persistent condition keeps the same key tick-to-tick, so its event is published once on the
/// rising edge while the active fault still rides every tick in the retained system-state frame.
pub type FaultKey = (String, Option<String>, FaultType);

/// The key identifying one fault.
fn fault_key(fault: &Fault) -> FaultKey {
    (
        fault.component.clone(),
        fault.zone_id.as_ref().map(|z| z.as_str().to_string()),
        fault.fault_type,
    )
}

/// The set of faults active in this snapshot — the publisher carries this forward to distinguish a
/// newly-occurring fault (publish an event) from one that simply persists.
pub fn active_fault_keys(snapshot: &Snapshot) -> std::collections::BTreeSet<FaultKey> {
    snapshot.faults.iter().map(fault_key).collect()
}

/// Build every telemetry frame for a tick: per-metric sensor readings, per-actuator state, fault
/// events, and the retained consolidated system-state. A `gh/{id}/fault` event is emitted only for
/// faults **not** in `previously_active` ([interfaces §2] — events publish "as they occur"; active
/// faults live in the retained system-state). Pass an empty set to emit every active fault.
pub fn telemetry_frames(
    snapshot: &Snapshot,
    greenhouse_id: &str,
    base: DateTime<Utc>,
    time_scale: f64,
    previously_active: &std::collections::BTreeSet<FaultKey>,
) -> Vec<PublishFrame> {
    let ts = ts(base, snapshot.sim_seconds);
    let mut frames = Vec::new();

    // ── Per-metric sensor readings (gh/{id}/sensor/{metric}); only published when trusted. ──
    let house = [
        ("temperature", snapshot.trusted.temperature, "°C"),
        ("humidity", snapshot.trusted.humidity, "%RH"),
        ("co2", snapshot.trusted.co2, "ppm"),
        ("par", snapshot.trusted.par, "µmol·m⁻²·s⁻¹"),
        ("vpd", snapshot.trusted.vpd, "kPa"),
    ];
    for (metric, value, unit) in house {
        if let Some(value) = value {
            let msg = SensorReadingMsg {
                schema_version: SCHEMA_VERSION,
                greenhouse_id,
                zone_id: None,
                ts: &ts,
                metric,
                value,
                unit,
            };
            frames.push(frame(
                format!("gh/{greenhouse_id}/sensor/{metric}"),
                &msg,
                false,
            ));
        }
    }
    // Per-zone soil moisture (gh/{id}/zone/{zone}/sensor/soil_moisture).
    for (zone, reading) in &snapshot.trusted.soil_moisture {
        if let Some(value) = reading {
            let z = zone.as_str();
            let msg = SensorReadingMsg {
                schema_version: SCHEMA_VERSION,
                greenhouse_id,
                zone_id: Some(z),
                ts: &ts,
                metric: "soil_moisture",
                value: *value,
                unit: "VWC",
            };
            frames.push(frame(
                format!("gh/{greenhouse_id}/zone/{z}/sensor/soil_moisture"),
                &msg,
                false,
            ));
        }
    }

    // ── Per-actuator state (gh/{id}/actuator/{name}/state) — house actuators only. ──
    for actuator in HOUSE_ACTUATORS {
        let name = actuator_name(actuator);
        let id = ActuatorId::House(actuator);
        let msg = ActuatorStateMsg {
            schema_version: SCHEMA_VERSION,
            greenhouse_id,
            zone_id: None,
            ts: &ts,
            actuator: name,
            commanded: OutputState::new(actuator, snapshot.commanded.get(&id)),
            observed: OutputState::new(actuator, snapshot.observed.get(&id)),
            health: health_str(name, &snapshot.faults),
            overridden: snapshot.overrides.contains_key(&id),
        };
        frames.push(frame(
            format!("gh/{greenhouse_id}/actuator/{name}/state"),
            &msg,
            false,
        ));
    }

    // ── Fault events (gh/{id}/fault) — only on the rising edge (newly-active faults). ──
    for fault in &snapshot.faults {
        if previously_active.contains(&fault_key(fault)) {
            continue;
        }
        let msg = FaultEventMsg {
            schema_version: SCHEMA_VERSION,
            greenhouse_id,
            zone_id: fault.zone_id.as_ref().map(|z| z.as_str().to_string()),
            ts: &ts,
            component: &fault.component,
            fault_type: fault.fault_type,
            severity: fault.severity,
            message: &fault.message,
            response: &fault.response,
        };
        frames.push(frame(format!("gh/{greenhouse_id}/fault"), &msg, false));
    }

    // ── Retained consolidated system state (gh/{id}/state). ──
    frames.push(frame(
        format!("gh/{greenhouse_id}/state"),
        &system_state(snapshot, greenhouse_id, &ts, time_scale),
        true,
    ));

    frames
}

/// Build just the retained system-state frame (used on (re)connect priming and each tick).
pub fn system_state_frame(
    snapshot: &Snapshot,
    greenhouse_id: &str,
    base: DateTime<Utc>,
    time_scale: f64,
) -> PublishFrame {
    let ts = ts(base, snapshot.sim_seconds);
    frame(
        format!("gh/{greenhouse_id}/state"),
        &system_state(snapshot, greenhouse_id, &ts, time_scale),
        true,
    )
}

fn system_state<'a>(
    snapshot: &'a Snapshot,
    greenhouse_id: &'a str,
    ts: &'a str,
    time_scale: f64,
) -> SystemStateMsg<'a> {
    let sensors = Sensors {
        temperature: snapshot
            .trusted
            .temperature
            .map(|value| ReadingVu { value, unit: "°C" }),
        humidity: snapshot
            .trusted
            .humidity
            .map(|value| ReadingVu { value, unit: "%RH" }),
        co2: snapshot
            .trusted
            .co2
            .map(|value| ReadingVu { value, unit: "ppm" }),
        par: snapshot.trusted.par.map(|value| ReadingVu {
            value,
            unit: "µmol·m⁻²·s⁻¹",
        }),
        vpd: snapshot
            .trusted
            .vpd
            .map(|value| ReadingVu { value, unit: "kPa" }),
    };

    let zones = snapshot
        .trusted
        .soil_moisture
        .iter()
        .map(|(zone, reading)| {
            let valve = snapshot.commanded.get(&ActuatorId::Valve(zone.clone()));
            let faulted = reading.is_none()
                || snapshot
                    .faults
                    .iter()
                    .any(|f| f.zone_id.as_ref() == Some(zone));
            ZoneEntry {
                zone_id: zone.as_str().to_string(),
                soil_moisture: reading.map(|value| ReadingVu { value, unit: "VWC" }),
                irrigation: OutputState::new(Actuator::IrrigationValve, valve),
                faulted,
            }
        })
        .collect();

    let actuators = HOUSE_ACTUATORS
        .iter()
        .map(|&actuator| {
            let name = actuator_name(actuator);
            let id = ActuatorId::House(actuator);
            ActuatorEntry {
                actuator: name,
                commanded: OutputState::new(actuator, snapshot.commanded.get(&id)),
                observed: OutputState::new(actuator, snapshot.observed.get(&id)),
                health: health_str(name, &snapshot.faults),
                overridden: snapshot.overrides.contains_key(&id),
            }
        })
        .collect();

    let faults = snapshot
        .faults
        .iter()
        .map(|f| FaultSummary {
            component: f.component.clone(),
            zone_id: f.zone_id.as_ref().map(|z| z.as_str().to_string()),
            fault_type: f.fault_type,
            severity: f.severity,
        })
        .collect();

    // Override deadlines are in tick-index space; convert to the simulated instant.
    let offset = snapshot.sim_seconds.saturating_sub(snapshot.tick_index);
    let overrides = snapshot
        .overrides
        .iter()
        .map(|(id, ov)| {
            let (actuator, zone_id) = match id {
                ActuatorId::House(a) => (*a, None),
                ActuatorId::Valve(z) => (Actuator::IrrigationValve, Some(z.as_str().to_string())),
            };
            OverrideEntry {
                actuator: actuator_name(actuator),
                zone_id,
                state: OutputState::new(actuator, ov.level),
                expires_at: Some(ts_from_offset(offset, ov.expires_at_tick)),
            }
        })
        .collect();

    SystemStateMsg {
        schema_version: SCHEMA_VERSION,
        greenhouse_id,
        zone_id: None,
        ts,
        controller: Controller {
            mode: snapshot.mode,
            healthy: snapshot.healthy(),
        },
        sensors,
        zones,
        actuators,
        faults,
        overrides,
        simulation: Some(SimulationBlock {
            time_scale,
            tick_index: snapshot.tick_index,
        }),
    }
}

fn ts_from_offset(offset_seconds: u64, tick: u64) -> String {
    ts(epoch(), offset_seconds + tick)
}

fn frame<T: Serialize>(topic: String, msg: &T, retain: bool) -> PublishFrame {
    PublishFrame {
        topic,
        payload: serde_json::to_vec(msg).expect("telemetry serializes"),
        retain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::hal::SimulatedHal;
    use crate::pipeline::Pipeline;

    fn snapshot() -> Snapshot {
        let cfg = Config::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        ))
        .unwrap();
        let hal = SimulatedHal::new(&cfg);
        let mut p = Pipeline::new(cfg, hal);
        let mut last = p.tick();
        for _ in 0..10 {
            last = p.tick();
        }
        last
    }

    #[test]
    fn builds_expected_frame_topics() {
        let snap = snapshot();
        let frames = telemetry_frames(&snap, "gh-a", epoch(), 1.0, &Default::default());
        // 7 house actuators + retained state are always present.
        assert!(
            frames
                .iter()
                .any(|f| f.topic == "gh/gh-a/actuator/heater/state")
        );
        let state = frames
            .iter()
            .find(|f| f.topic == "gh/gh-a/state")
            .expect("retained state frame");
        assert!(state.retain, "system-state must be retained");
        // Sensor readings present for trusted house metrics.
        assert!(
            frames
                .iter()
                .any(|f| f.topic == "gh/gh-a/sensor/temperature")
        );
    }

    #[test]
    fn fault_events_fire_only_on_rising_edge() {
        let mut snap = snapshot();
        snap.faults.push(Fault::new(
            "co2",
            FaultType::Co2Ceiling,
            Severity::Alarm,
            "ceiling exceeded",
            "vents open",
        ));

        // Rising edge (no prior active faults) → the event is published.
        let frames = telemetry_frames(&snap, "gh-a", epoch(), 1.0, &Default::default());
        assert!(
            frames.iter().any(|f| f.topic == "gh/gh-a/fault"),
            "a newly-active fault publishes its event"
        );

        // Same fault still active next tick → no duplicate event...
        let prev = active_fault_keys(&snap);
        let frames = telemetry_frames(&snap, "gh-a", epoch(), 1.0, &prev);
        assert!(
            !frames.iter().any(|f| f.topic == "gh/gh-a/fault"),
            "a persisting fault is not re-emitted as a new event"
        );
        // ...but it still rides the retained system-state frame every tick.
        assert!(frames.iter().any(|f| f.topic == "gh/gh-a/state"));
    }

    #[test]
    fn system_state_has_required_envelope_and_blocks() {
        let snap = snapshot();
        let frame = system_state_frame(&snap, "gh-a", epoch(), 2.0);
        let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["greenhouse_id"], "gh-a");
        assert!(v["zone_id"].is_null());
        assert!(v["ts"].is_string());
        assert!(v["controller"]["mode"].is_string());
        assert_eq!(v["simulation"]["time_scale"], 2.0);
        assert!(v["sensors"].is_object());
        assert!(v["actuators"].is_array());
        assert_eq!(v["actuators"].as_array().unwrap().len(), 7);
        assert_eq!(v["zones"].as_array().unwrap().len(), 2);
    }
}
