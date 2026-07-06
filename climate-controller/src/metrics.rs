//! Prometheus instrumentation for the controller's own health ([interfaces §5]).
//!
//! The controller is its **own source of truth**: it measures its control loop (tick cadence and
//! compute budget, `P1-PERF-3`), its MQTT publish path (published/dropped frames + connection, the
//! `P1-RESIL-3` backpressure signal), its fault/mode state, and the config applies it accepts over
//! REST. The metrics are served unauthenticated at `GET /metrics` (a read, so the write-auth
//! middleware leaves it open) for Prometheus to scrape directly over the internal network — the
//! metrics sibling of the `/health` surface, distinct from the MQTT telemetry it publishes.
//!
//! Every metric carries a `greenhouse_id` const label (the controller id), so a scrape is
//! self-describing and the platform's Grafana can group the fleet by greenhouse.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use prometheus::{
    Encoder, Gauge, Histogram, HistogramOpts, IntCounter, IntCounterVec, IntGauge, Opts, Registry,
    TextEncoder,
};

use crate::faults::{FaultType, Mode};
use crate::state::Snapshot;
use crate::telemetry::{FaultKey, active_fault_keys};

/// A tick whose compute time exceeds this budget is counted an overrun (`P1-PERF-3`, ≤ 100 ms).
const TICK_COMPUTE_BUDGET: Duration = Duration::from_millis(100);

/// Frames published vs dropped in one `publish_snapshot` call (dropped = shed under broker
/// backpressure, `P1-RESIL-3`).
#[derive(Debug, Default, Clone, Copy)]
pub struct PublishStats {
    /// Frames handed to the client's outbound buffer.
    pub published: u64,
    /// Frames dropped because the bounded buffer was full (broker unreachable).
    pub dropped: u64,
}

/// The controller's Prometheus registry and its collectors.
pub struct Metrics {
    registry: Registry,
    ticks: IntCounter,
    tick_duration: Histogram,
    tick_overruns: IntCounter,
    time_scale: Gauge,
    mqtt_published: IntCounter,
    mqtt_dropped: IntCounter,
    mqtt_connected: IntGauge,
    active_faults: IntGauge,
    faults: IntCounterVec,
    mode: IntGauge,
    config_applies: IntCounterVec,
    /// Faults active at the last tick, so `faults_total` counts each fault on its rising edge only
    /// (mirroring the edge-triggered MQTT fault events) rather than every tick it persists.
    prev_faults: Mutex<BTreeSet<FaultKey>>,
}

impl Metrics {
    /// Build the registry (with `greenhouse_id` as a const label on every metric) and register the
    /// collectors. Panics only on a programming error (duplicate metric name).
    pub fn new(greenhouse_id: &str) -> Self {
        let mut labels = HashMap::new();
        labels.insert("greenhouse_id".to_string(), greenhouse_id.to_string());
        let registry = Registry::new_custom(None, Some(labels)).expect("build prometheus registry");

        let ticks = IntCounter::new("controller_ticks_total", "Control-loop ticks executed.")
            .expect("ticks metric");
        let tick_duration = Histogram::with_opts(HistogramOpts::new(
            "controller_tick_duration_seconds",
            "Per-tick pipeline compute time (P1-PERF-3, budget 100 ms).",
        ))
        .expect("tick duration metric");
        let tick_overruns = IntCounter::new(
            "controller_tick_overruns_total",
            "Ticks whose compute time exceeded the P1-PERF-3 budget.",
        )
        .expect("overruns metric");
        let time_scale = Gauge::new(
            "controller_time_scale",
            "Current simulation time-scale (wall-clock ticks per simulated second at 1x).",
        )
        .expect("time scale metric");
        let mqtt_published = IntCounter::new(
            "controller_mqtt_frames_published_total",
            "Telemetry frames handed to the MQTT client.",
        )
        .expect("mqtt published metric");
        let mqtt_dropped = IntCounter::new(
            "controller_mqtt_frames_dropped_total",
            "Telemetry frames dropped under broker backpressure (P1-RESIL-3).",
        )
        .expect("mqtt dropped metric");
        let mqtt_connected = IntGauge::new(
            "controller_mqtt_connected",
            "Whether the MQTT event loop last reported a healthy connection (1) or not (0).",
        )
        .expect("mqtt connected metric");
        let active_faults = IntGauge::new(
            "controller_active_faults",
            "Count of faults active this tick.",
        )
        .expect("active faults metric");
        let faults = IntCounterVec::new(
            Opts::new(
                "controller_faults_total",
                "Faults counted on their rising edge, by fault_type.",
            ),
            &["type"],
        )
        .expect("faults metric");
        let mode = IntGauge::new(
            "controller_mode",
            "Controller mode: 0 normal, 1 degraded, 2 interlock.",
        )
        .expect("mode metric");
        let config_applies = IntCounterVec::new(
            Opts::new(
                "controller_config_applies_total",
                "Runtime config writes accepted over REST, by endpoint.",
            ),
            &["endpoint"],
        )
        .expect("config applies metric");

        for collector in [
            Box::new(ticks.clone()) as Box<dyn prometheus::core::Collector>,
            Box::new(tick_duration.clone()),
            Box::new(tick_overruns.clone()),
            Box::new(time_scale.clone()),
            Box::new(mqtt_published.clone()),
            Box::new(mqtt_dropped.clone()),
            Box::new(mqtt_connected.clone()),
            Box::new(active_faults.clone()),
            Box::new(faults.clone()),
            Box::new(mode.clone()),
            Box::new(config_applies.clone()),
        ] {
            registry.register(collector).expect("register collector");
        }

        Metrics {
            registry,
            ticks,
            tick_duration,
            tick_overruns,
            time_scale,
            mqtt_published,
            mqtt_dropped,
            mqtt_connected,
            active_faults,
            faults,
            mode,
            config_applies,
            prev_faults: Mutex::new(BTreeSet::new()),
        }
    }

    /// Record one completed tick: cadence, compute time + overrun, time-scale, fault count/mode, and
    /// any faults newly active this tick.
    pub fn record_tick(&self, elapsed: Duration, snapshot: &Snapshot, time_scale: f64) {
        self.ticks.inc();
        self.tick_duration.observe(elapsed.as_secs_f64());
        if elapsed > TICK_COMPUTE_BUDGET {
            self.tick_overruns.inc();
        }
        self.time_scale.set(time_scale);
        self.active_faults.set(snapshot.faults.len() as i64);
        self.mode.set(mode_code(snapshot.mode));

        let current = active_fault_keys(snapshot);
        let mut prev = self.prev_faults.lock().expect("prev_faults poisoned");
        for key in current.difference(&prev) {
            self.faults
                .with_label_values(&[fault_type_label(key.2)])
                .inc();
        }
        *prev = current;
    }

    /// Record the outcome of one publish (published + backpressure-dropped frames).
    pub fn record_publish(&self, stats: PublishStats) {
        self.mqtt_published.inc_by(stats.published);
        self.mqtt_dropped.inc_by(stats.dropped);
    }

    /// Record the MQTT connection state as last observed by the event loop.
    pub fn set_mqtt_connected(&self, connected: bool) {
        self.mqtt_connected.set(connected as i64);
    }

    /// Record one accepted runtime config write (endpoint = setpoints/zones/overrides).
    pub fn record_config_apply(&self, endpoint: &str) {
        self.config_applies.with_label_values(&[endpoint]).inc();
    }

    /// Render the Prometheus text exposition for the `/metrics` handler.
    pub fn render(&self) -> String {
        let mut buffer = Vec::new();
        let encoder = TextEncoder::new();
        if encoder
            .encode(&self.registry.gather(), &mut buffer)
            .is_err()
        {
            return String::new();
        }
        String::from_utf8(buffer).unwrap_or_default()
    }
}

fn mode_code(mode: Mode) -> i64 {
    match mode {
        Mode::Normal => 0,
        Mode::Degraded => 1,
        Mode::Interlock => 2,
    }
}

/// The snake_case wire name of a fault type, reusing its serde mapping so the metric label cannot
/// drift from the MQTT `fault_type` vocabulary.
fn fault_type_label(fault_type: FaultType) -> &'static str {
    match fault_type {
        FaultType::Stuck => "stuck",
        FaultType::OutOfRange => "out_of_range",
        FaultType::SensorDisagreement => "sensor_disagreement",
        FaultType::RedundancyDegraded => "redundancy_degraded",
        FaultType::TemperatureUnavailable => "temperature_unavailable",
        FaultType::CriticalTemperature => "critical_temperature",
        FaultType::Co2Ceiling => "co2_ceiling",
        FaultType::IrrigationNoResponse => "irrigation_no_response",
        FaultType::ActuatorStuck => "actuator_stuck",
        FaultType::ActuatorNoResponse => "actuator_no_response",
        FaultType::SetpointUnreachable => "setpoint_unreachable",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::control::ResolvedSetpoints;
    use crate::faults::{Fault, Severity};
    use crate::hal::Commands;
    use crate::sensing::TrustedState;

    fn snapshot_with(faults: Vec<Fault>) -> Snapshot {
        Snapshot {
            tick_index: 1,
            sim_seconds: 1,
            trusted: TrustedState {
                temperature: None,
                humidity: None,
                co2: None,
                par: None,
                vpd: None,
                soil_moisture: BTreeMap::new(),
            },
            resolved: ResolvedSetpoints {
                temperature_c: 0.0,
                humidity_target_pct: None,
                humidity_low_pct: 0.0,
                humidity_high_pct: 0.0,
                humidity_deadband_pct: 0.0,
                co2_target_ppm: 0.0,
                vent_interlock_threshold_pct: 0.0,
                dli_target_mol: 0.0,
            },
            commanded: Commands::default(),
            observed: Commands::default(),
            overrides: BTreeMap::new(),
            mode: Mode::from_faults(&faults),
            faults,
            dli_mol: 0.0,
        }
    }

    #[test]
    fn records_ticks_and_exposes_greenhouse_label() {
        let m = Metrics::new("gh-a");
        m.record_tick(Duration::from_millis(5), &snapshot_with(vec![]), 1.0);
        let text = m.render();
        assert!(
            text.contains("controller_ticks_total{greenhouse_id=\"gh-a\"} 1"),
            "{text}"
        );
        assert!(
            text.contains("controller_mode{greenhouse_id=\"gh-a\"} 0"),
            "{text}"
        );
    }

    #[test]
    fn counts_faults_on_rising_edge_only() {
        let m = Metrics::new("gh-a");
        let fault = Fault::new(
            "temperature",
            FaultType::OutOfRange,
            Severity::Warning,
            "oor",
            "disabled",
        );
        // Same fault persists across two ticks — counted once (rising edge), and mode is degraded.
        m.record_tick(
            Duration::from_millis(5),
            &snapshot_with(vec![fault.clone()]),
            1.0,
        );
        m.record_tick(Duration::from_millis(5), &snapshot_with(vec![fault]), 1.0);
        let text = m.render();
        // The prometheus crate emits the metric's own labels first, then the const label.
        assert!(
            text.contains(
                "controller_faults_total{type=\"out_of_range\",greenhouse_id=\"gh-a\"} 1"
            ),
            "{text}"
        );
        assert!(
            text.contains("controller_active_faults{greenhouse_id=\"gh-a\"} 1"),
            "{text}"
        );
        assert!(
            text.contains("controller_mode{greenhouse_id=\"gh-a\"} 1"),
            "{text}"
        );
    }

    #[test]
    fn overrun_counted_past_budget() {
        let m = Metrics::new("gh-a");
        m.record_tick(Duration::from_millis(5), &snapshot_with(vec![]), 1.0);
        m.record_tick(Duration::from_millis(150), &snapshot_with(vec![]), 1.0);
        assert!(
            m.render()
                .contains("controller_tick_overruns_total{greenhouse_id=\"gh-a\"} 1")
        );
    }

    #[test]
    fn records_publish_and_config_applies() {
        let m = Metrics::new("gh-a");
        m.record_publish(PublishStats {
            published: 4,
            dropped: 1,
        });
        m.set_mqtt_connected(true);
        m.record_config_apply("setpoints");
        let text = m.render();
        assert!(
            text.contains("controller_mqtt_frames_published_total{greenhouse_id=\"gh-a\"} 4"),
            "{text}"
        );
        assert!(
            text.contains("controller_mqtt_frames_dropped_total{greenhouse_id=\"gh-a\"} 1"),
            "{text}"
        );
        assert!(
            text.contains("controller_mqtt_connected{greenhouse_id=\"gh-a\"} 1"),
            "{text}"
        );
        assert!(
            text.contains(
                "controller_config_applies_total{endpoint=\"setpoints\",greenhouse_id=\"gh-a\"} 1"
            ),
            "{text}"
        );
    }
}
