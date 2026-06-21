//! Stage ① — sensing, fusion & fault detection ([sensing]).
//!
//! Raw HAL readings become the **trusted state** the loops consume: redundant temperature probes
//! are fused by median voting ([sensing §2]), VPD is derived from fused temperature + humidity
//! ([sensing §3]), and every non-temperature sensor runs stuck + out-of-range detection
//! ([sensing §4]). A faulted quantity becomes `None` in [`TrustedState`] (the loop fails safe) and
//! a [`Fault`] is raised. Recovery is automatic: trust returns the tick the condition clears.

use std::collections::BTreeMap;

use crate::config::Sensing;
use crate::domain::Slug;
use crate::faults::{Fault, FaultType, Severity};
use crate::hal::RawReadings;

/// The conditioned, trusted readings the control loops consume. `None` means "not currently
/// trustworthy" — the corresponding loop falls back or fails safe.
#[derive(Debug, Clone, PartialEq)]
pub struct TrustedState {
    /// Fused air temperature (°C); `None` on total probe disagreement (temperature unavailable).
    pub temperature: Option<f64>,
    /// Relative humidity (%RH); `None` if the sensor is faulted.
    pub humidity: Option<f64>,
    /// CO₂ (ppm); `None` if faulted.
    pub co2: Option<f64>,
    /// PAR (µmol·m⁻²·s⁻¹); `None` if faulted.
    pub par: Option<f64>,
    /// Derived vapor-pressure deficit (kPa); `None` if temperature or humidity is unavailable.
    pub vpd: Option<f64>,
    /// Per-zone soil moisture (VWC); `None` for a faulted zone sensor.
    pub soil_moisture: BTreeMap<Slug, Option<f64>>,
}

/// Saturation vapor pressure over water at `temp_c`, in kPa (Tetens/Magnus form). Backs **both**
/// the observed VPD and the humidity loop's inverted RH target, so the two cannot drift apart
/// ([sensing §3]).
pub fn saturation_vapor_pressure_kpa(temp_c: f64) -> f64 {
    0.610_78 * ((17.27 * temp_c) / (temp_c + 237.3)).exp()
}

/// Air vapor-pressure deficit (kPa) from temperature + relative humidity.
pub fn vpd_kpa(temp_c: f64, rh_pct: f64) -> f64 {
    saturation_vapor_pressure_kpa(temp_c) * (1.0 - rh_pct / 100.0)
}

/// Tracks how long a single channel's reading has been frozen, for stuck detection.
#[derive(Debug, Clone, Default)]
struct StuckTracker {
    last: Option<f64>,
    unchanged: u64,
}

impl StuckTracker {
    /// Record a reading; return the number of consecutive unchanged ticks (0 on a change).
    fn observe(&mut self, value: f64) -> u64 {
        match self.last {
            Some(prev) if prev == value => self.unchanged += 1,
            _ => self.unchanged = 0,
        }
        self.last = Some(value);
        self.unchanged
    }
}

/// Across-tick sensing state: per-channel stuck trackers (temperature uses fusion, not stuck
/// detection, so it needs none). Held by the pipeline and reused each tick.
#[derive(Debug, Clone)]
pub struct SensingState {
    humidity: StuckTracker,
    co2: StuckTracker,
    par: StuckTracker,
    soil: BTreeMap<Slug, StuckTracker>,
}

impl SensingState {
    /// Build state for the given zones.
    pub fn new(zone_ids: &[Slug]) -> Self {
        SensingState {
            humidity: StuckTracker::default(),
            co2: StuckTracker::default(),
            par: StuckTracker::default(),
            soil: zone_ids
                .iter()
                .map(|z| (z.clone(), StuckTracker::default()))
                .collect(),
        }
    }

    /// Condition one tick of raw readings into trusted state, appending any faults.
    pub fn condition(
        &mut self,
        raw: &RawReadings,
        cfg: &Sensing,
        faults: &mut Vec<Fault>,
    ) -> TrustedState {
        let temperature = fuse_temperature(&raw.temperature_probes, cfg, faults);

        let humidity_unchanged = self.humidity.observe(raw.humidity_pct);
        let humidity = classify(
            "humidity",
            None,
            raw.humidity_pct,
            cfg.humidity_bounds,
            humidity_unchanged,
            cfg.stuck_window_secs,
            "disabled misters; suspended VPD feedforward",
            faults,
        );

        let co2_unchanged = self.co2.observe(raw.co2_ppm);
        let co2 = classify(
            "co2",
            None,
            raw.co2_ppm,
            cfg.co2_bounds,
            co2_unchanged,
            cfg.stuck_window_secs,
            "disabled CO₂ injector (fail-closed)",
            faults,
        );

        let par_unchanged = self.par.observe(raw.par);
        let par = classify(
            "par",
            None,
            raw.par,
            cfg.par_bounds,
            par_unchanged,
            cfg.stuck_window_secs,
            "fell back to time-based lighting",
            faults,
        );

        // VPD is derived: it needs both fused temperature and trusted humidity.
        let vpd = match (temperature, humidity) {
            (Some(t), Some(h)) => Some(vpd_kpa(t, h)),
            _ => None,
        };

        let mut soil_moisture = BTreeMap::new();
        let zones: Vec<Slug> = raw.soil_moisture.keys().cloned().collect();
        for zone in zones {
            let value = raw.soil_moisture.get(&zone).copied().unwrap_or(0.0);
            let unchanged = self.soil.entry(zone.clone()).or_default().observe(value);
            let trusted = classify(
                "soil_moisture",
                Some(zone.clone()),
                value,
                cfg.soil_moisture_bounds,
                unchanged,
                cfg.stuck_window_secs,
                "disabled this zone's irrigation (fail-closed)",
                faults,
            );
            soil_moisture.insert(zone, trusted);
        }

        TrustedState {
            temperature,
            humidity,
            co2,
            par,
            vpd,
            soil_moisture,
        }
    }
}

/// Median-vote the temperature probes, excluding outliers ([sensing §2]). Returns the fused value,
/// or `None` when no two probes agree (temperature unavailable).
fn fuse_temperature(probes: &[f64], cfg: &Sensing, faults: &mut Vec<Fault>) -> Option<f64> {
    if probes.is_empty() {
        faults.push(Fault::new(
            "temperature",
            FaultType::TemperatureUnavailable,
            Severity::Alarm,
            "no temperature probes configured",
            "holding safe state",
        ));
        return None;
    }
    // A single probe has no redundancy: trust it directly (still subject to interlocks).
    if probes.len() == 1 {
        return Some(probes[0]);
    }

    let m = median(probes);
    let good: Vec<f64> = probes
        .iter()
        .copied()
        .filter(|p| (p - m).abs() <= cfg.probe_disagreement_c)
        .collect();

    if good.len() >= 2 {
        if good.len() < probes.len() {
            // At least one probe was excluded — still operational on the agreeing majority.
            faults.push(Fault::new(
                "temperature",
                FaultType::SensorDisagreement,
                Severity::Warning,
                format!(
                    "{} of {} temperature probes disagree with the median",
                    probes.len() - good.len(),
                    probes.len()
                ),
                "excluded the outlier probe(s); fusing the agreeing probes",
            ));
        }
        Some(mean(&good))
    } else {
        // No two probes agree: temperature is untrusted — hand off to the safety interlock.
        faults.push(Fault::new(
            "temperature",
            FaultType::TemperatureUnavailable,
            Severity::Alarm,
            "no two temperature probes agree",
            "treating temperature as unavailable; holding safe state",
        ));
        None
    }
}

/// Stuck + out-of-range classification for one non-temperature channel. Returns the trusted value,
/// or `None` (with a fault) when the channel is out-of-range or stuck.
#[allow(clippy::too_many_arguments)]
fn classify(
    component: &str,
    zone: Option<Slug>,
    value: f64,
    bounds: crate::config::Bounds,
    unchanged: u64,
    stuck_window: u64,
    response: &str,
    faults: &mut Vec<Fault>,
) -> Option<f64> {
    if !bounds.contains(value) {
        faults.push(scoped_fault(
            component,
            zone,
            FaultType::OutOfRange,
            Severity::Alarm,
            format!(
                "{component} reading {value} outside [{}, {}]",
                bounds.min, bounds.max
            ),
            response,
        ));
        return None;
    }
    if unchanged >= stuck_window {
        faults.push(scoped_fault(
            component,
            zone,
            FaultType::Stuck,
            Severity::Alarm,
            format!("{component} reading frozen at {value} for {unchanged} ticks"),
            response,
        ));
        return None;
    }
    Some(value)
}

fn scoped_fault(
    component: &str,
    zone: Option<Slug>,
    fault_type: FaultType,
    severity: Severity,
    message: String,
    response: &str,
) -> Fault {
    let fault = Fault::new(component, fault_type, severity, message, response);
    match zone {
        Some(z) => fault.in_zone(z),
        None => fault,
    }
}

/// Median of a non-empty slice (mean of the two middle elements for even length).
fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Sensing {
        Sensing::default()
    }

    fn raw(probes: Vec<f64>) -> RawReadings {
        RawReadings {
            temperature_probes: probes,
            humidity_pct: 60.0,
            co2_ppm: 800.0,
            par: 300.0,
            soil_moisture: BTreeMap::new(),
        }
    }

    #[test]
    fn svp_matches_known_values() {
        // ~2.34 kPa at 20 °C, ~4.24 kPa at 30 °C (standard references).
        assert!((saturation_vapor_pressure_kpa(20.0) - 2.34).abs() < 0.05);
        assert!((saturation_vapor_pressure_kpa(30.0) - 4.24).abs() < 0.05);
    }

    #[test]
    fn vpd_zero_at_saturation() {
        assert!(vpd_kpa(25.0, 100.0).abs() < 1e-9);
        assert!(vpd_kpa(25.0, 0.0) > 0.0);
    }

    #[test]
    fn three_probes_agree_full_trust() {
        let mut s = SensingState::new(&[]);
        let mut faults = Vec::new();
        let t = s.condition(&raw(vec![20.0, 20.1, 19.9]), &cfg(), &mut faults);
        assert!((t.temperature.unwrap() - 20.0).abs() < 0.2);
        assert!(faults.is_empty(), "no faults when probes agree: {faults:?}");
    }

    #[test]
    fn single_outlier_is_excluded_without_degradation() {
        // P1-REL-2: one wild probe, median voting still yields the true value.
        let mut s = SensingState::new(&[]);
        let mut faults = Vec::new();
        let t = s.condition(&raw(vec![20.0, 20.2, 80.0]), &cfg(), &mut faults);
        assert!((t.temperature.unwrap() - 20.1).abs() < 0.2, "fused {t:?}");
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::SensorDisagreement),
            "outlier should raise a disagreement warning"
        );
    }

    #[test]
    fn total_disagreement_makes_temperature_unavailable() {
        // P1-RESIL-1: no two probes agree → unavailable + alarm.
        let mut s = SensingState::new(&[]);
        let mut faults = Vec::new();
        let t = s.condition(&raw(vec![10.0, 40.0, 80.0]), &cfg(), &mut faults);
        assert_eq!(t.temperature, None);
        assert_eq!(t.vpd, None, "VPD unavailable without temperature");
        assert!(
            faults
                .iter()
                .any(|f| f.fault_type == FaultType::TemperatureUnavailable
                    && f.severity == Severity::Alarm)
        );
    }

    #[test]
    fn out_of_range_humidity_fails_safe() {
        let mut s = SensingState::new(&[]);
        let mut faults = Vec::new();
        let mut r = raw(vec![20.0, 20.0, 20.0]);
        r.humidity_pct = 150.0;
        let t = s.condition(&r, &cfg(), &mut faults);
        assert_eq!(t.humidity, None);
        assert!(
            faults
                .iter()
                .any(|f| f.component == "humidity" && f.fault_type == FaultType::OutOfRange)
        );
    }

    #[test]
    fn frozen_reading_is_detected_within_window() {
        // P1-REL-3: a constant CO₂ reading is flagged after the stuck window.
        let mut s = SensingState::new(&[]);
        let mut last = None;
        for _ in 0..(cfg().stuck_window_secs + 1) {
            let mut faults = Vec::new();
            let mut r = raw(vec![20.0, 20.05, 19.95]);
            r.co2_ppm = 800.0; // exactly constant
            last = Some(s.condition(&r, &cfg(), &mut faults).co2);
            if faults
                .iter()
                .any(|f| f.component == "co2" && f.fault_type == FaultType::Stuck)
            {
                assert_eq!(last, Some(None), "stuck channel becomes untrusted");
                return;
            }
        }
        panic!("CO₂ stuck fault was never raised (last trusted: {last:?})");
    }

    #[test]
    fn per_zone_soil_fault_is_scoped() {
        let zone: Slug = "bench-a".parse().unwrap();
        let mut s = SensingState::new(std::slice::from_ref(&zone));
        let mut faults = Vec::new();
        let mut r = raw(vec![20.0, 20.0, 20.0]);
        r.soil_moisture.insert(zone.clone(), 5.0); // out of [0,1]
        let t = s.condition(&r, &cfg(), &mut faults);
        assert_eq!(t.soil_moisture.get(&zone), Some(&None));
        assert!(
            faults
                .iter()
                .any(|f| f.component == "soil_moisture" && f.zone_id.as_ref() == Some(&zone))
        );
    }
}
