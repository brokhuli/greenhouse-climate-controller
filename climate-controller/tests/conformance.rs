//! Contract conformance ([verification §4]).
//!
//! Proves the controller's REST DTOs accept the contract's example fixtures and that its published
//! MQTT frames carry the envelope + payload fields the schemas require — so a drift between the
//! controller and `contracts/` fails here, in-toolchain. (The authoritative JSON-Schema check is
//! the Node harness, `npm run validate:contracts`; this is its in-Rust complement.)

use std::path::PathBuf;

use jsonschema::{Resource, Validator};

use climate_controller::config::{Config, Setpoints};
use climate_controller::hal::{SensorChannel, SimControl, SimulatedHal};
use climate_controller::pipeline::Pipeline;
use climate_controller::rest::{
    HealthDto, OverridePut, SensorInjectionDto, SensorInjectionPut, SetpointsPatch, TimeScaleDto,
    TimeScalePut, ZoneConfigPatch, ZoneStatusDto,
};
use climate_controller::state::Snapshot;
use climate_controller::telemetry::{epoch, telemetry_frames};
use serde_json::Value;

fn rest_fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../contracts/platform-controller-control-rest/examples")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("fixture {path:?} should exist"))
}

fn assert_keys(value: &Value, keys: &[&str]) {
    let obj = value.as_object().expect("expected a JSON object");
    for key in keys {
        assert!(obj.contains_key(*key), "missing key `{key}` in {value}");
    }
}

// ───────────────────────────── full JSON-Schema validation of emitted payloads ─────────────────────────────
// Beyond key-presence, validate the controller's *generated* JSON against the same `contracts/`
// schemas the Node/Ajv harness checks (verification spec §4) — so wrong types, bad enums/units,
// failed patterns, or stray fields fail here in-toolchain, not just in CI.

const ID_BASE: &str = "https://greenhouse.local/";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Register every contract schema as a `jsonschema` resource keyed by its `$id` — embedded for the
/// MQTT schemas, injected from the repo-relative path for the OpenAPI component fragments (which
/// carry none). This mirrors the Node harness's `$id` registry ([validate-contracts.mjs]) so a
/// validator built from any one schema resolves its cross-file `$ref`s (e.g. the shared envelope)
/// offline.
fn schema_resources() -> Vec<(String, Resource)> {
    let root = repo_root();
    let mut out = Vec::new();
    for (rel_dir, inject_id) in [
        ("contracts/controller-platform-telemetry-mqtt", false),
        (
            "contracts/platform-controller-control-rest/components/schemas",
            true,
        ),
    ] {
        let dir = root.join(rel_dir);
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}")) {
            let path = entry.unwrap().path();
            let Some(file) = path.file_name().and_then(|f| f.to_str()) else {
                continue;
            };
            if !file.ends_with(".json") {
                continue;
            }
            let mut schema: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let id = if inject_id {
                let id = format!("{ID_BASE}{rel_dir}/{file}");
                schema["$id"] = Value::String(id.clone());
                id
            } else {
                schema["$id"]
                    .as_str()
                    .unwrap_or_else(|| panic!("{file} should embed $id"))
                    .to_string()
            };
            out.push((id, Resource::from_contents(schema).unwrap()));
        }
    }
    out
}

/// A validator that resolves `reference` (an absolute `$id`, optionally with a `#/Component` pointer)
/// against the full contract registry.
fn validator_for(reference: &str) -> Validator {
    jsonschema::options()
        .with_resources(schema_resources().into_iter())
        .build(&serde_json::json!({ "$ref": reference }))
        .unwrap_or_else(|e| panic!("schema {reference} should compile: {e}"))
}

/// Validator for one MQTT message schema, by file name.
fn mqtt_validator(file: &str) -> Validator {
    validator_for(&format!(
        "{ID_BASE}contracts/controller-platform-telemetry-mqtt/{file}"
    ))
}

/// Validator for one platform-controller-control-rest component schema (`file` + `#/Component`).
fn rest_validator(file: &str, component: &str) -> Validator {
    validator_for(&format!(
        "{ID_BASE}contracts/platform-controller-control-rest/components/schemas/{file}#/{component}"
    ))
}

fn assert_schema_valid(validator: &Validator, instance: &Value, label: &str) {
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|e| e.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "{label} is not schema-valid:\n  {}\npayload: {instance}",
        errors.join("\n  ")
    );
}

// ───────────────────────────── REST request DTOs accept the fixtures ─────────────────────────────

#[test]
fn setpoints_patch_request_parses() {
    serde_json::from_str::<SetpointsPatch>(&rest_fixture("setpoints.patch.json"))
        .expect("SetpointsPatch accepts the contract fixture");
}

#[test]
fn zone_config_patch_request_parses() {
    serde_json::from_str::<ZoneConfigPatch>(&rest_fixture("zone-config.patch.json"))
        .expect("ZoneConfigPatch accepts the contract fixture");
}

#[test]
fn override_put_request_parses() {
    serde_json::from_str::<OverridePut>(&rest_fixture("override.put.json"))
        .expect("OverridePut accepts the contract fixture");
}

#[test]
fn sensor_injection_put_request_parses() {
    serde_json::from_str::<SensorInjectionPut>(&rest_fixture("sim-injection.put.json"))
        .expect("SensorInjectionPut accepts the contract fixture");
}

#[test]
fn time_scale_put_request_parses() {
    serde_json::from_str::<TimeScalePut>(&rest_fixture("sim-time-scale.put.json"))
        .expect("TimeScalePut accepts the contract fixture");
}

// ───────────────────────────── REST response DTOs match the fixtures ─────────────────────────────

#[test]
fn setpoints_response_matches_controller_type() {
    let setpoints: Setpoints = serde_json::from_str(&rest_fixture("setpoints.json"))
        .expect("Setpoints accepts the contract fixture");
    // Re-serialize and confirm the controller emits the full required field set.
    let value = serde_json::to_value(&setpoints).unwrap();
    assert_keys(
        &value,
        &[
            "temperature_day_c",
            "temperature_night_c",
            "day_start",
            "day_end",
            "humidity_low_pct",
            "humidity_high_pct",
            "humidity_deadband_pct",
            "co2_target_ppm",
            "co2_vent_interlock_threshold_pct",
            "vpd_target_kpa",
            "dli_target_mol",
        ],
    );
    assert_schema_valid(
        &rest_validator("setpoints.json", "Setpoints"),
        &value,
        "setpoints response",
    );
}

#[test]
fn zone_status_response_roundtrips() {
    let dto: ZoneStatusDto = serde_json::from_str(&rest_fixture("zone-status.json"))
        .expect("ZoneStatusDto accepts the contract fixture");
    assert_eq!(dto.zone_id, "bench-a");
    let value = serde_json::to_value(&dto).unwrap();
    assert_keys(
        &value,
        &[
            "zone_id",
            "moisture_low_threshold",
            "moisture_high_threshold",
            "drain_period_secs",
            "schedule",
            "soil_moisture_vwc",
            "irrigating",
            "faulted",
            "last_cycle_ts",
        ],
    );
    assert_schema_valid(
        &rest_validator("zones.json", "ZoneStatus"),
        &value,
        "zone-status response",
    );
}

#[test]
fn health_response_roundtrips() {
    let dto: HealthDto = serde_json::from_str(&rest_fixture("health.json"))
        .expect("HealthDto accepts the contract fixture");
    assert!(!dto.healthy);
    assert_eq!(dto.faults.len(), 2);
    let value = serde_json::to_value(&dto).unwrap();
    assert_keys(&value, &["mode", "healthy", "faults", "ts"]);
    assert_schema_valid(
        &rest_validator("health.json", "Health"),
        &value,
        "health response",
    );
}

#[test]
fn sensor_injection_response_roundtrips() {
    let dto: SensorInjectionDto = serde_json::from_str(&rest_fixture("sim-injection.json"))
        .expect("SensorInjectionDto accepts the contract fixture");
    assert_eq!(dto.metric, "temperature");
    let value = serde_json::to_value(&dto).unwrap();
    assert_keys(
        &value,
        &[
            "metric",
            "value",
            "probe_index",
            "zone_id",
            "created_at",
            "expires_at",
        ],
    );
    assert_schema_valid(
        &rest_validator("sim.json", "SensorInjection"),
        &value,
        "sensor-injection response",
    );
}

#[test]
fn time_scale_response_roundtrips() {
    let dto: TimeScaleDto = serde_json::from_str(&rest_fixture("sim-time-scale.json"))
        .expect("TimeScaleDto accepts the contract fixture");
    assert_eq!(dto.scale, 2.0);
    let value = serde_json::to_value(&dto).unwrap();
    assert_keys(&value, &["scale", "tick_index", "updated_at"]);
    assert_schema_valid(
        &rest_validator("sim.json", "TimeScale"),
        &value,
        "time-scale response",
    );
}

// ───────────────────────────── MQTT published frames carry the schema fields ─────────────────────────────

fn snapshot_with_fault() -> Snapshot {
    let cfg = Config::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/config/greenhouse.example.toml"
    ))
    .unwrap();
    let hal = SimulatedHal::new(&cfg);
    let mut p = Pipeline::new(cfg, hal);
    for _ in 0..5 {
        p.tick();
    }
    // Force an out-of-range CO₂ reading so a fault-event frame is produced.
    p.hal_mut()
        .inject_sensor(SensorChannel::Co2, 99_000.0, Some(20));
    p.tick()
}

fn frame_value(frames: &[climate_controller::telemetry::PublishFrame], topic: &str) -> Value {
    let frame = frames
        .iter()
        .find(|f| f.topic == topic)
        .unwrap_or_else(|| panic!("frame for topic {topic} should be published"));
    serde_json::from_slice(&frame.payload).unwrap()
}

#[test]
fn mqtt_frames_carry_required_schema_fields() {
    let snap = snapshot_with_fault();
    // Empty "previously active" set → every active fault publishes its event (rising edge).
    let frames = telemetry_frames(&snap, "gh-a", epoch(), 1.0, &Default::default());

    // Envelope (RFC-007) — present on every message.
    let envelope = ["schema_version", "greenhouse_id", "zone_id", "ts"];

    // sensor-reading.schema.json
    let sensor = frame_value(&frames, "gh/gh-a/sensor/temperature");
    assert_keys(&sensor, &envelope);
    assert_keys(&sensor, &["metric", "value", "unit"]);
    assert_eq!(sensor["unit"], "°C");
    assert_schema_valid(
        &mqtt_validator("sensor-reading.schema.json"),
        &sensor,
        "sensor-reading frame",
    );
    // Guard the check is non-vacuous: the metric→unit conditional must reject a wrong unit, proving
    // cross-file `$ref` (envelope) and `if/then` resolution are actually wired up.
    let mut bad_unit = sensor.clone();
    bad_unit["unit"] = Value::String("ppm".into());
    assert!(
        !mqtt_validator("sensor-reading.schema.json").is_valid(&bad_unit),
        "a temperature reading with a non-°C unit must fail schema validation"
    );

    // actuator-state.schema.json
    let actuator = frame_value(&frames, "gh/gh-a/actuator/heater/state");
    assert_keys(&actuator, &envelope);
    assert_keys(
        &actuator,
        &["actuator", "commanded", "observed", "health", "overridden"],
    );
    assert_keys(&actuator["commanded"], &["on", "level_pct"]);
    assert_schema_valid(
        &mqtt_validator("actuator-state.schema.json"),
        &actuator,
        "actuator-state frame",
    );

    // fault-event.schema.json (the injected CO₂ out-of-range)
    let fault = frame_value(&frames, "gh/gh-a/fault");
    assert_keys(&fault, &envelope);
    assert_keys(
        &fault,
        &["component", "fault_type", "severity", "message", "response"],
    );
    assert_schema_valid(
        &mqtt_validator("fault-event.schema.json"),
        &fault,
        "fault-event frame",
    );

    // system-state.schema.json (retained)
    let state = frame_value(&frames, "gh/gh-a/state");
    assert_keys(&state, &envelope);
    assert!(
        state["zone_id"].is_null(),
        "system-state is greenhouse-scoped"
    );
    assert_keys(
        &state,
        &[
            "controller",
            "sensors",
            "dli",
            "zones",
            "actuators",
            "faults",
            "overrides",
            "simulation",
        ],
    );
    assert_keys(&state["controller"], &["mode", "healthy"]);
    assert_keys(
        &state["sensors"],
        &["temperature", "humidity", "co2", "par", "vpd"],
    );
    assert_keys(&state["dli"], &["value", "unit"]);
    assert_eq!(state["dli"]["unit"], "mol·m⁻²·d⁻¹");
    assert_keys(&state["simulation"], &["time_scale", "tick_index"]);
    assert_schema_valid(
        &mqtt_validator("system-state.schema.json"),
        &state,
        "system-state frame",
    );
}
