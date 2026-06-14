//! Shared validation primitives.
//!
//! This module is is the project’s validation toolkit: create consistent field errors,
//! collect them, format them, serialize them, and wrap them into config-loading errors.
//!
//! [`FieldViolation`] mirrors the REST contract's `ValidationError`
//! (`contracts/controller-rest/components/schemas/common.json`), so the same value can be
//! returned by config loading now and by the REST `PATCH` handlers later — one validator,
//! one rejection shape, no drift with the contract.

use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

/// A single rejected field: the offending field, the violated bound, and the bad value.
/// Serializes to the contract `ValidationError` shape `{ error, field, bound, value }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldViolation {
    /// Human-readable description of the violation.
    pub error: String,
    /// The offending field, e.g. `humidity_low_pct`.
    pub field: String,
    /// The violated constraint, e.g. `0..=100` or `must be < humidity_high_pct`.
    pub bound: String,
    /// The rejected value, echoed back (omitted from the body when null).
    #[serde(skip_serializing_if = "Value::is_null")]
    pub value: Value,
}

impl FieldViolation {
    /// Build a violation, deriving the human-readable `error` from `field` and `bound`.
    pub fn new(field: impl Into<String>, bound: impl Into<String>, value: Value) -> Self {
        let field = field.into();
        let bound = bound.into();
        let error = format!("`{field}` violates constraint: {bound}");
        FieldViolation {
            error,
            field,
            bound,
            value,
        }
    }
}

impl fmt::Display for FieldViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (constraint: {}", self.field, self.bound)?;
        if !self.value.is_null() {
            write!(f, ", got {}", self.value)?;
        }
        f.write_str(")")
    }
}

/// Push a violation unless `value` lies within the inclusive range `[min, max]`.
pub fn check_range<T>(violations: &mut Vec<FieldViolation>, field: &str, value: T, min: T, max: T)
where
    T: PartialOrd + Copy + fmt::Display + Serialize,
{
    if value < min || value > max {
        violations.push(FieldViolation::new(
            field,
            format!("{min}..={max}"),
            serde_json::to_value(value).unwrap_or(Value::Null),
        ));
    }
}

/// Push a violation unless `value >= min`.
pub fn check_min<T>(violations: &mut Vec<FieldViolation>, field: &str, value: T, min: T)
where
    T: PartialOrd + Copy + fmt::Display + Serialize,
{
    if value < min {
        violations.push(FieldViolation::new(
            field,
            format!(">= {min}"),
            serde_json::to_value(value).unwrap_or(Value::Null),
        ));
    }
}

/// Failure modes of [`crate::config::Config::load`].
#[derive(Debug)]
pub enum ConfigError {
    /// The config file could not be read.
    Io {
        /// Path that failed to read.
        path: PathBuf,
        /// Underlying IO error.
        source: std::io::Error,
    },
    /// The file was not valid TOML, or a typed field failed to parse (slug, time-of-day).
    Parse {
        /// Path that failed to parse.
        path: PathBuf,
        /// Underlying TOML deserialization error.
        source: toml::de::Error,
    },
    /// The config parsed but failed semantic validation (bounds, cross-field invariants).
    Invalid(Vec<FieldViolation>),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Io { path, source } => {
                write!(f, "failed to read config {}: {source}", path.display())
            }
            ConfigError::Parse { path, source } => {
                write!(f, "failed to parse config {}: {source}", path.display())
            }
            ConfigError::Invalid(violations) => {
                writeln!(
                    f,
                    "config validation failed ({} issue(s)):",
                    violations.len()
                )?;
                for v in violations {
                    writeln!(f, "  - {v}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigError::Io { source, .. } => Some(source),
            ConfigError::Parse { source, .. } => Some(source),
            ConfigError::Invalid(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_check_flags_out_of_bounds() {
        let mut v = Vec::new();
        check_range(&mut v, "humidity_high_pct", 150.0, 0.0, 100.0);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].field, "humidity_high_pct");
        assert_eq!(v[0].bound, "0..=100");
        assert_eq!(v[0].value, serde_json::json!(150.0));
    }

    #[test]
    fn range_check_passes_in_bounds() {
        let mut v = Vec::new();
        check_range(&mut v, "co2_target_ppm", 1000_u32, 0_u32, 5000_u32);
        check_min(&mut v, "vpd_target_kpa", 1.0, 0.0);
        assert!(v.is_empty());
    }

    #[test]
    fn violation_serializes_to_contract_shape() {
        let v = FieldViolation::new("humidity_high_pct", "0..=100", serde_json::json!(150.0));
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["field"], "humidity_high_pct");
        assert_eq!(json["bound"], "0..=100");
        assert_eq!(json["value"], 150.0);
        assert!(json["error"].is_string());
    }
}
