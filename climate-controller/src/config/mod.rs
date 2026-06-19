//! Controller configuration (controller spec §4, §3, §9, §13).
//!
//! A TOML file loaded at startup. [`Config::load`] reads, parses, and **validates** in one
//! call: it deserializes into typed structs (slugs and times parse-and-validate at the serde
//! boundary), then runs semantic validation that collects *all* bound/invariant violations
//! before returning. The bound checks are shared with the future REST `PATCH` path so the
//! config and the runtime API enforce the same contract.

mod connection;
mod hal;
mod setpoints;
mod zones;

pub use connection::{Api, Mqtt};
pub use hal::{ActuatorModel, Constraints, Disturbances, Effect, Hal, TimeConstants};
pub use setpoints::Setpoints;
pub use zones::Zone;

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::Slug;
use crate::validation::{ConfigError, FieldViolation};

/// The complete controller configuration for one greenhouse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// This greenhouse's identity (its key in MQTT topics, REST paths, and DB rows).
    pub controller_id: Slug,
    /// MQTT telemetry connection.
    pub mqtt: Mqtt,
    /// REST config/control server binding.
    pub api: Api,
    /// Global climate setpoints.
    pub setpoints: Setpoints,
    /// Irrigation zones (may be empty).
    #[serde(default)]
    pub zones: Vec<Zone>,
    /// HAL simulation model.
    pub hal: Hal,
}

impl Config {
    /// Read, parse, and validate the TOML config at `path`.
    pub fn load(path: impl AsRef<Path>) -> Result<Config, ConfigError> {
        let path = path.as_ref();
        let text = fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let config: Config = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        config.validate()?;
        Ok(config)
    }

    /// Run semantic validation, collecting every violation. Returns
    /// [`ConfigError::Invalid`] if any field is out of bounds or an invariant is broken.
    pub fn validate(&self) -> Result<(), ConfigError> {
        let mut violations: Vec<FieldViolation> = Vec::new();
        self.mqtt.validate(&mut violations);
        self.api.validate(&mut violations);
        self.setpoints.validate(&mut violations);
        self.hal.validate(&mut violations);

        let mut seen = HashSet::new();
        for zone in &self.zones {
            if !seen.insert(zone.id.as_str()) {
                violations.push(FieldViolation::new(
                    format!("zones.{}", zone.id),
                    "duplicate zone id",
                    serde_json::json!(zone.id.as_str()),
                ));
            }
            zone.validate(&mut violations);
        }

        if violations.is_empty() {
            Ok(())
        } else {
            Err(ConfigError::Invalid(violations))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
controller_id = "gh-a"

[mqtt]
broker_url = "mqtt://localhost:1883"

[api]
bind_addr = "127.0.0.1:8080"

[setpoints]
temperature_day_c = 24.0
temperature_night_c = 18.0
day_start = "06:00"
day_end = "20:00"
humidity_low_pct = 50.0
humidity_high_pct = 85.0
humidity_deadband_pct = 5.0
co2_target_ppm = 1000
co2_vent_interlock_threshold_pct = 15.0
vpd_target_kpa = 1.0
dli_target_mol = 20.0

[hal.time_constants]
temperature_s = 120
humidity_s = 60
co2_s = 30
par_s = 10
soil_moisture_s = 1800

[hal.disturbances]
outdoor_temp_c = 10.0
ambient_humidity_pct = 50.0
heat_loss_coeff = 0.02
plant_co2_uptake_ppm_per_s = 0.5
soil_drying_rate_per_s = 0.00001

[[hal.actuators]]
actuator = "heater"
effects = [{ variable = "temperature", gain = 0.05 }]
constraints = { min_on_secs = 60, min_off_secs = 60 }
"#;

    #[test]
    fn minimal_config_parses_and_validates() {
        let config: Config = toml::from_str(MINIMAL).unwrap();
        config.validate().expect("minimal config should validate");
        assert_eq!(config.controller_id.as_str(), "gh-a");
        assert!(config.zones.is_empty());
    }

    #[test]
    fn unknown_field_is_a_parse_error() {
        let text = format!("{MINIMAL}\nbogus_field = true\n");
        assert!(toml::from_str::<Config>(&text).is_err());
    }

    #[test]
    fn duplicate_zone_ids_are_flagged() {
        let zone = r#"
[[zones]]
id = "bench-a"
moisture_low_threshold = 0.35
moisture_high_threshold = 0.55
drain_period_secs = 300
schedule = "06:00"
"#;
        let text = format!("{MINIMAL}{zone}{zone}");
        let config: Config = toml::from_str(&text).unwrap();
        let err = config.validate().unwrap_err();
        match err {
            ConfigError::Invalid(v) => {
                assert!(v.iter().any(|x| x.bound == "duplicate zone id"));
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }
}
