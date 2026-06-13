//! Shared domain types used across configuration, the HAL, and the wire layer.
//!
//! The enums mirror the closed enums in the MQTT contract
//! (`contracts/mqtt/actuator-state.schema.json`, `sensor-reading.schema.json`) so the
//! controller's internal vocabulary cannot drift from what it publishes. The newtypes
//! (`Slug`, `TimeOfDay`, `Schedule`) parse-and-validate at the deserialization boundary, so
//! every value held downstream is already well-formed.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The eight controllable actuators. Variant names match the MQTT `actuator` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actuator {
    Heater,
    Fans,
    RoofVents,
    Misters,
    Co2Injector,
    GrowLights,
    ShadeScreen,
    IrrigationValve,
}

/// A simulated climate state variable an actuator can affect (a HAL coupling target).
///
/// These are the *driven* state variables. `vpd` is derived from temperature + humidity and
/// is never a direct actuator effect, so it is intentionally absent here even though it
/// appears in the MQTT `metric` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClimateVariable {
    Temperature,
    Humidity,
    Co2,
    Par,
    SoilMoisture,
}

/// A lowercase kebab-case identifier (`^[a-z0-9]+(-[a-z0-9]+)*$`), per RFC-007 identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Slug(String);

impl Slug {
    /// The slug as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for Slug {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // Valid iff every hyphen-separated segment is non-empty and all-lowercase-alnum.
        // This rejects empty strings, leading/trailing hyphens, and consecutive hyphens.
        let valid = !s.is_empty()
            && s.split('-').all(|seg| {
                !seg.is_empty()
                    && seg
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            });
        if valid {
            Ok(Slug(s.to_string()))
        } else {
            Err(format!(
                "invalid slug {s:?}: expected lowercase kebab-case (a-z, 0-9, single hyphens)"
            ))
        }
    }
}

impl fmt::Display for Slug {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A local time-of-day, `HH:MM` (24-hour). Matches the contract pattern for `day_start`,
/// `day_end`, and zone schedule entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimeOfDay {
    hour: u8,
    minute: u8,
}

impl TimeOfDay {
    /// Hour component, `0..=23`.
    pub fn hour(&self) -> u8 {
        self.hour
    }

    /// Minute component, `0..=59`.
    pub fn minute(&self) -> u8 {
        self.minute
    }

    /// Minutes since midnight (`0..=1439`) — convenient for day-window comparisons.
    pub fn minutes_since_midnight(&self) -> u16 {
        u16::from(self.hour) * 60 + u16::from(self.minute)
    }
}

impl FromStr for TimeOfDay {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let err = || format!("invalid time-of-day {s:?}: expected HH:MM (00:00..=23:59)");
        let (h, m) = s.split_once(':').ok_or_else(err)?;
        // Require exactly two digits each, matching the contract's HH:MM pattern.
        if h.len() != 2 || m.len() != 2 {
            return Err(err());
        }
        let hour: u8 = h.parse().map_err(|_| err())?;
        let minute: u8 = m.parse().map_err(|_| err())?;
        if hour > 23 || minute > 59 {
            return Err(err());
        }
        Ok(TimeOfDay { hour, minute })
    }
}

impl fmt::Display for TimeOfDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}:{:02}", self.hour, self.minute)
    }
}

/// One or more time-of-day triggers, parsed from a comma-separated `HH:MM` list
/// (e.g. `"06:00,14:00"`). Used by per-zone irrigation scheduling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule(Vec<TimeOfDay>);

impl Schedule {
    /// The trigger times, in declaration order.
    pub fn times(&self) -> &[TimeOfDay] {
        &self.0
    }
}

impl FromStr for Schedule {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.is_empty() {
            return Err("schedule must list at least one HH:MM trigger".to_string());
        }
        let times = s
            .split(',')
            .map(TimeOfDay::from_str)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Schedule(times))
    }
}

impl fmt::Display for Schedule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let joined = self
            .0
            .iter()
            .map(TimeOfDay::to_string)
            .collect::<Vec<_>>()
            .join(",");
        f.write_str(&joined)
    }
}

/// Derive `serde` impls for a string newtype from its `FromStr` + `Display`. Deserialization
/// validates (parse-don't-validate); serialization round-trips via `Display`.
macro_rules! str_serde {
    ($t:ty) => {
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                s.parse().map_err(serde::de::Error::custom)
            }
        }

        impl Serialize for $t {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_str(self)
            }
        }
    };
}

str_serde!(Slug);
str_serde!(TimeOfDay);
str_serde!(Schedule);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_accepts_valid_kebab() {
        for ok in ["gh-a", "bench-a", "seedling-tray", "zone1", "a"] {
            assert_eq!(ok.parse::<Slug>().unwrap().as_str(), ok);
        }
    }

    #[test]
    fn slug_rejects_malformed() {
        for bad in ["", "-a", "a-", "a--b", "A", "a_b", "a b", "café"] {
            assert!(
                bad.parse::<Slug>().is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn time_of_day_parses_and_orders() {
        let t = "06:30".parse::<TimeOfDay>().unwrap();
        assert_eq!((t.hour(), t.minute()), (6, 30));
        assert_eq!(t.minutes_since_midnight(), 390);
        assert!("06:00".parse::<TimeOfDay>().unwrap() < "20:00".parse::<TimeOfDay>().unwrap());
        assert_eq!(t.to_string(), "06:30");
    }

    #[test]
    fn time_of_day_rejects_malformed() {
        for bad in ["6:00", "06:0", "24:00", "12:60", "1200", "ab:cd", ""] {
            assert!(
                bad.parse::<TimeOfDay>().is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn schedule_parses_comma_list_and_round_trips() {
        let s = "06:00,14:00".parse::<Schedule>().unwrap();
        assert_eq!(s.times().len(), 2);
        assert_eq!(s.to_string(), "06:00,14:00");
        assert!("".parse::<Schedule>().is_err());
        assert!("06:00,bad".parse::<Schedule>().is_err());
    }
}
