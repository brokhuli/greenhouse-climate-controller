//! Integration + contract-conformance tests for the configuration layer.
//!
//! The conformance tests deserialize the REST contract's example fixtures into the controller's
//! own `Setpoints` struct and run the same validator the runtime `PATCH` path will use — so a
//! drift between the controller's bounds and the contract fails here, in-toolchain, with no
//! separate JSON-Schema harness.

use std::path::PathBuf;

use climate_controller::config::{Config, Setpoints};
use climate_controller::validation::FieldViolation;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn validate_setpoints(setpoints: &Setpoints) -> Vec<FieldViolation> {
    let mut violations = Vec::new();
    setpoints.validate(&mut violations);
    violations
}

#[test]
fn example_config_loads_and_validates() {
    let path = manifest_dir().join("config/greenhouse.example.toml");
    let config = Config::load(&path).expect("example config should load and validate");
    assert_eq!(config.controller_id.as_str(), "gh-a");
    assert_eq!(config.zones.len(), 2);
    assert_eq!(config.hal.actuators.len(), 8);
}

#[test]
fn rest_setpoints_fixture_passes_the_same_validator() {
    let path = manifest_dir()
        .join("../contracts/platform-controller-control-rest/examples/setpoints.json");
    let json = std::fs::read_to_string(&path).expect("fixture should exist");
    let setpoints: Setpoints = serde_json::from_str(&json).expect("valid fixture deserializes");
    let violations = validate_setpoints(&setpoints);
    assert!(
        violations.is_empty(),
        "valid fixture should not violate: {violations:?}"
    );
}

#[test]
fn rest_bad_range_fixture_is_rejected_by_the_same_validator() {
    let path = manifest_dir()
        .join("../contracts/platform-controller-control-rest/examples/setpoints.bad-range.json");
    let json = std::fs::read_to_string(&path).expect("fixture should exist");
    let setpoints: Setpoints =
        serde_json::from_str(&json).expect("fixture is structurally valid JSON");
    let violations = validate_setpoints(&setpoints);
    assert!(
        violations
            .iter()
            .any(|v| v.field == "humidity_high_pct" && v.bound == "0..=100"),
        "expected humidity_high_pct range violation, got {violations:?}"
    );
}
