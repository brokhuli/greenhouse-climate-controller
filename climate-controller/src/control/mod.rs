//! Stage ②+③ — setpoint resolution and the control-loop hierarchy ([control-loops]).
//!
//! [`resolve`] picks the active setpoints for the tick (day/night temperature; the humidity target
//! derived from `vpd_target_kpa` at the fused temperature, clamped to the safety bounds). Then
//! [`ControlState::run`] evaluates the loops in dependency order — temperature first (it owns the
//! shared cooling actuators), then humidity, CO₂ (which reads the resolved vent position for its
//! interlock), irrigation, and lighting — producing the *desired* actuator levels. Manual override,
//! safety interlocks, and actuator constraints may still modify these downstream.

pub mod co2;
pub mod humidity;
pub mod irrigation;
pub mod lighting;
pub mod pid;
pub mod temperature;

use std::collections::{BTreeMap, BTreeSet};

use crate::clock::Clock;
use crate::config::{Config, Setpoints};
use crate::domain::Slug;
use crate::faults::Fault;
use crate::hal::{ActuatorId, Commands};
use crate::sensing::{TrustedState, saturation_vapor_pressure_kpa};

use humidity::HumidityLoop;
use irrigation::IrrigationLoop;
use lighting::LightingLoop;
use temperature::TemperatureLoop;

/// The setpoints active for the current tick, after day/night and VPD resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSetpoints {
    /// Active air-temperature setpoint (°C) — day or night.
    pub temperature_c: f64,
    /// RH target derived from VPD at the fused temperature, clamped to the safety bounds; `None`
    /// when temperature is unavailable (the humidity loop falls back to the midpoint band).
    pub humidity_target_pct: Option<f64>,
    /// Lower humidity safety bound (%RH).
    pub humidity_low_pct: f64,
    /// Upper humidity safety bound (%RH).
    pub humidity_high_pct: f64,
    /// Hysteresis band width around the derived target (%RH).
    pub humidity_deadband_pct: f64,
    /// CO₂ enrichment target (ppm).
    pub co2_target_ppm: f64,
    /// Vent position above which the CO₂ injector is interlocked off (% open).
    pub vent_interlock_threshold_pct: f64,
    /// Daily Light Integral target (mol·m⁻²·day⁻¹).
    pub dli_target_mol: f64,
}

/// Resolve the active setpoints for this tick from config, the clock, and the fused temperature.
pub fn resolve(
    setpoints: &Setpoints,
    clock: &Clock,
    temperature: Option<f64>,
) -> ResolvedSetpoints {
    let temperature_c = if clock.is_within(setpoints.day_start, setpoints.day_end) {
        setpoints.temperature_day_c
    } else {
        setpoints.temperature_night_c
    };

    // Derive the RH target by inverting VPD at the fused temperature, then clamp to the safety
    // bounds — the single svp function backs both this and the observed VPD ([sensing §3]).
    let humidity_target_pct = temperature.map(|t| {
        let svp = saturation_vapor_pressure_kpa(t);
        let target = 100.0 * (1.0 - setpoints.vpd_target_kpa / svp);
        target.clamp(setpoints.humidity_low_pct, setpoints.humidity_high_pct)
    });

    ResolvedSetpoints {
        temperature_c,
        humidity_target_pct,
        humidity_low_pct: setpoints.humidity_low_pct,
        humidity_high_pct: setpoints.humidity_high_pct,
        humidity_deadband_pct: setpoints.humidity_deadband_pct,
        co2_target_ppm: f64::from(setpoints.co2_target_ppm),
        vent_interlock_threshold_pct: setpoints.co2_vent_interlock_threshold_pct,
        dli_target_mol: setpoints.dli_target_mol,
    }
}

/// Across-tick state for the whole control layer: per-loop sub-states.
#[derive(Debug, Clone)]
pub struct ControlState {
    temperature: TemperatureLoop,
    humidity: HumidityLoop,
    lighting: LightingLoop,
    zones: BTreeMap<Slug, IrrigationLoop>,
}

impl ControlState {
    /// Build the control layer from config.
    pub fn new(config: &Config) -> Self {
        let zones = config
            .zones
            .iter()
            .map(|z| (z.id.clone(), IrrigationLoop::new(z.id.clone())))
            .collect();
        ControlState {
            temperature: TemperatureLoop::new(config),
            humidity: HumidityLoop::new(),
            lighting: LightingLoop::new(),
            zones,
        }
    }

    /// The per-zone irrigation scheduler state (for building zone status).
    pub fn irrigation(&self, zone: &Slug) -> Option<&IrrigationLoop> {
        self.zones.get(zone)
    }

    /// The day's accumulated Daily Light Integral (mol·m⁻²·d⁻¹) from the lighting loop, for telemetry.
    pub fn accumulated_dli(&self) -> f64 {
        self.lighting.accumulated_dli()
    }

    /// Run every loop in dependency order, returning the desired actuator commands for this tick.
    /// Actuators a loop drives to their fail-safe state because the governing sensor became
    /// untrusted (CO₂ injector, irrigation valve) are recorded in `fail_closed` so the constraints
    /// stage waives anti-short-cycle dwell on the safe move ([sensing §4], [safety §4]).
    pub fn run(
        &mut self,
        trusted: &TrustedState,
        resolved: &ResolvedSetpoints,
        config: &Config,
        clock: &Clock,
        faults: &mut Vec<Fault>,
        fail_closed: &mut BTreeSet<ActuatorId>,
    ) -> Commands {
        let zone_ids: Vec<Slug> = config.zones.iter().map(|z| z.id.clone()).collect();
        let mut cmd = Commands::all_off(&zone_ids);

        // Temperature first: it owns the shared cooling actuators (fans + vents).
        self.temperature
            .run(trusted, resolved, &mut cmd, config, faults);
        // Humidity hysteresis (misters).
        self.humidity.run(trusted, resolved, &mut cmd);
        // CO₂ — reads the resolved vent position for its interlock, so it must run after temperature.
        co2::run(trusted, resolved, &mut cmd, fail_closed);
        // Irrigation — one independent scheduler per zone.
        for zone in &config.zones {
            if let Some(loop_) = self.zones.get_mut(&zone.id) {
                let soil = trusted.soil_moisture.get(&zone.id).copied().flatten();
                loop_.run(zone, soil, clock, &mut cmd, fail_closed);
            }
        }
        // Lighting / DLI (grow lights + shade screen).
        self.lighting
            .run(trusted, resolved, clock, config, &mut cmd);

        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setpoints() -> Setpoints {
        toml::from_str(
            r#"
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
"#,
        )
        .unwrap()
    }

    #[test]
    fn resolves_day_and_night_temperature() {
        let sp = setpoints();
        let day = resolve(&sp, &Clock::starting_at_seconds(12 * 3600), Some(22.0));
        assert_eq!(day.temperature_c, 24.0);
        let night = resolve(&sp, &Clock::starting_at_seconds(2 * 3600), Some(18.0));
        assert_eq!(night.temperature_c, 18.0);
    }

    #[test]
    fn derives_humidity_target_from_vpd_and_clamps() {
        let sp = setpoints();
        // At 24 °C, svp ≈ 2.985 kPa; target_rh = 100·(1 − 1.0/2.985) ≈ 66.5%, inside [50,85].
        let r = resolve(&sp, &Clock::starting_at_seconds(12 * 3600), Some(24.0));
        let rh = r.humidity_target_pct.unwrap();
        assert!((rh - 66.5).abs() < 1.5, "derived RH was {rh}");
    }

    #[test]
    fn humidity_target_tracks_temperature() {
        let sp = setpoints();
        // Higher temperature → higher svp → higher RH target for the same VPD.
        let warm = resolve(&sp, &Clock::starting_at_seconds(12 * 3600), Some(30.0))
            .humidity_target_pct
            .unwrap();
        let cool = resolve(&sp, &Clock::starting_at_seconds(12 * 3600), Some(20.0))
            .humidity_target_pct
            .unwrap();
        assert!(
            warm > cool,
            "RH target should rise with temperature ({cool} → {warm})"
        );
    }

    #[test]
    fn humidity_target_none_when_temperature_unavailable() {
        let sp = setpoints();
        let r = resolve(&sp, &Clock::starting_at_seconds(12 * 3600), None);
        assert_eq!(r.humidity_target_pct, None);
    }
}
