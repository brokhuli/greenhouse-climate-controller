//! Connection configuration: the MQTT broker the controller publishes to and the REST bind
//! address. Defined here in the config slice; consumed by the MQTT and REST slices later.

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::validation::FieldViolation;

/// MQTT telemetry connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mqtt {
    /// Broker URL the controller publishes telemetry to, e.g. `mqtt://localhost:1883`.
    pub broker_url: String,
}

impl Mqtt {
    /// Append a violation if the broker URL is empty.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        if self.broker_url.trim().is_empty() {
            violations.push(FieldViolation::new(
                "mqtt.broker_url",
                "must not be empty",
                serde_json::json!(self.broker_url),
            ));
        }
    }
}

/// REST config/control server binding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Api {
    /// Socket address the REST server binds, e.g. `127.0.0.1:8080`.
    pub bind_addr: String,
    /// Optional pre-shared bearer token guarding the REST **write** endpoints (RFC-011). Unset or
    /// empty → writes are unauthenticated (the zero-friction standalone default); set → PATCH/PUT/
    /// DELETE require a matching `Authorization: Bearer <token>` while reads stay open. In a managed
    /// deployment the platform holds the matching token and presents it on every downward call.
    #[serde(default)]
    pub auth_token: Option<String>,
}

impl Api {
    /// Append a violation if the bind address is not a valid `host:port`.
    pub fn validate(&self, violations: &mut Vec<FieldViolation>) {
        if self.bind_addr.parse::<SocketAddr>().is_err() {
            violations.push(FieldViolation::new(
                "api.bind_addr",
                "must be a host:port socket address",
                serde_json::json!(self.bind_addr),
            ));
        }
    }

    /// The active write-auth token, or `None` when unset/empty. Empty is treated as disabled so a
    /// stray `auth_token = ""` does not silently require callers to send an empty bearer.
    pub fn write_auth_token(&self) -> Option<&str> {
        self.auth_token.as_deref().filter(|token| !token.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_connection_has_no_violations() {
        let mut v = Vec::new();
        Mqtt {
            broker_url: "mqtt://localhost:1883".to_string(),
        }
        .validate(&mut v);
        Api {
            bind_addr: "127.0.0.1:8080".to_string(),
            auth_token: None,
        }
        .validate(&mut v);
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn bad_bind_addr_is_flagged() {
        let mut v = Vec::new();
        Api {
            bind_addr: "not-an-addr".to_string(),
            auth_token: None,
        }
        .validate(&mut v);
        assert!(v.iter().any(|x| x.field == "api.bind_addr"));
    }

    #[test]
    fn auth_token_is_optional_and_empty_means_disabled() {
        // Absent field deserializes to None (write-auth disabled).
        let api: Api = toml::from_str(r#"bind_addr = "127.0.0.1:8080""#).unwrap();
        assert_eq!(api.auth_token, None);
        assert_eq!(api.write_auth_token(), None);

        // An explicit empty string is also treated as disabled.
        let empty: Api =
            toml::from_str("bind_addr = \"127.0.0.1:8080\"\nauth_token = \"\"").unwrap();
        assert_eq!(empty.write_auth_token(), None);

        // A non-empty token is the active credential.
        let set: Api =
            toml::from_str("bind_addr = \"127.0.0.1:8080\"\nauth_token = \"s3cret\"").unwrap();
        assert_eq!(set.write_auth_token(), Some("s3cret"));
    }
}
