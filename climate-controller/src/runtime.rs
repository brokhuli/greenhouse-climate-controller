//! The async runtime that wires the deterministic core to its I/O edges ([architecture §3]).
//!
//! One **tick task** owns the [`Pipeline`] and drives it on a wall-clock cadence of
//! `tick_period / time_scale`. It drains latched [`Command`]s at each tick boundary, runs the tick,
//! publishes the committed snapshot to the **MQTT** publisher (non-blocking) and to a `watch`
//! channel the **REST** server reads. REST writes flow back over an `mpsc` channel — so REST never
//! touches the pipeline directly, and a slow/blocked broker never stalls control (`P1-RESIL-3`).

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

use crate::config::Config;
use crate::domain::Slug;
use crate::hal::{ActuatorId, SensorChannel, SimControl, SimulatedHal};
use crate::pipeline::Pipeline;
use crate::rest::{
    AppState, Command, FaultSummaryDto, HealthDto, InjectionKey, OverrideDto, PlausibilityBounds,
    RuntimeView, SensorInjectionDto, ZoneStatusDto, router,
};
use crate::state::Snapshot;
use crate::telemetry::{OutputState, actuator_name, epoch, instant_ts};

/// The 1× wall-clock tick period (`P1-PERF-1`).
const TICK_PERIOD_MS: f64 = 1000.0;
/// Latched-command channel capacity.
const COMMAND_CAP: usize = 64;
/// How often the resource sampler inspects this process's CPU/memory. Comfortably above sysinfo's
/// per-OS `MINIMUM_CPU_UPDATE_INTERVAL` (so CPU deltas are valid) and fresh within Prometheus's 15 s
/// scrape interval.
const RESOURCE_SAMPLE_PERIOD: std::time::Duration = std::time::Duration::from_secs(5);

/// The wall-clock interval between ticks at a given time-scale: `tick_period / scale`, never below
/// 1 ms. Determinism is preserved because only the cadence changes, not the per-tick step.
fn tick_interval(scale: f64) -> std::time::Duration {
    std::time::Duration::from_millis((TICK_PERIOD_MS / scale).round().max(1.0) as u64)
}

/// Bookkeeping for an active sensor injection, for the REST DTO listing.
struct InjectionRecord {
    value: f64,
    created_at_seconds: u64,
    expires_at_seconds: u64,
}

/// Run the controller: build the pipeline, connect MQTT, serve REST, and tick forever.
pub async fn run(config: Config) -> Result<(), Box<dyn Error>> {
    let greenhouse_id = config.controller_id.as_str().to_string();
    let bind_addr = config.api.bind_addr.clone();
    let auth_token: Option<Arc<str>> = config.api.write_auth_token().map(Arc::from);
    let broker_url = config.mqtt.broker_url.clone();
    let override_timeout = config.safety.override_timeout_secs;
    let injection_default_ttl = config.simulation.sensor_injection_timeout_secs;
    let probe_count = config.sensing.probe_count.max(1);
    let plausibility = PlausibilityBounds {
        temperature: config.sensing.temperature_bounds,
        humidity: config.sensing.humidity_bounds,
        co2: config.sensing.co2_bounds,
        par: config.sensing.par_bounds,
        soil_moisture: config.sensing.soil_moisture_bounds,
    };
    let base = epoch();

    // Controller-health metrics, shared between the tick loop, the MQTT event loop, and the REST
    // /metrics handler.
    let metrics = Arc::new(crate::metrics::Metrics::new(&greenhouse_id));

    // Sample this process's own CPU/memory on a dedicated task, off the control-loop hot path
    // (sysinfo does syscalls), so a slow read never stalls a tick (`P1-RESIL-3`).
    spawn_resource_sampler(metrics.clone());

    let mut time_scale = config.simulation.time_scale;
    let mut time_scale_updated_at_seconds = 0u64;
    let mut injections: HashMap<InjectionKey, InjectionRecord> = HashMap::new();

    let hal = SimulatedHal::new(&config);
    let mut pipeline = Pipeline::new(config, hal);

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<Command>(COMMAND_CAP);

    // First tick to seed the read model and the retained MQTT state.
    let tick_start = std::time::Instant::now();
    let snapshot = pipeline.tick();
    metrics.record_tick(tick_start.elapsed(), &snapshot, time_scale);
    let meta = ViewMeta {
        time_scale,
        time_scale_updated_at_seconds,
        override_timeout,
        injection_default_ttl,
        probe_count,
        base,
    };
    let view0 = build_view(&pipeline, &snapshot, &meta, &injections);
    let (view_tx, view_rx) = watch::channel(view0);

    let mut publisher =
        crate::mqtt::Publisher::connect(&broker_url, &greenhouse_id, metrics.clone());
    metrics.record_publish(publisher.publish_snapshot(&snapshot, time_scale));

    // Serve REST on its own task.
    let write_auth = auth_token.is_some();
    let state = AppState {
        greenhouse_id: greenhouse_id.clone().into(),
        tx: cmd_tx,
        view: view_rx,
        base,
        bounds: plausibility,
        auth_token,
        metrics: metrics.clone(),
    };
    let listener = TcpListener::bind(&bind_addr).await?;
    tracing::info!(%greenhouse_id, write_auth, "REST listening on {bind_addr}; MQTT → {broker_url}");
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router(state)).await {
            tracing::error!("REST server error: {err}");
        }
    });

    // The control loop. The tick cadence is `tick_period / time_scale`; a time-scale change is
    // accepted into scheduler state **immediately** — the wait deadline is recomputed from the last
    // tick — rather than only taking effect after the current (possibly slow) interval elapses
    // ([interfaces §3]).
    let mut last_tick = tokio::time::Instant::now();
    let mut next_tick = last_tick + tick_interval(time_scale);
    loop {
        // Wait until the next tick is due, applying latched writes as they arrive. A write that
        // changes the time-scale recomputes the deadline, so a speed-up takes effect now.
        loop {
            tokio::select! {
                biased;
                () = tokio::time::sleep_until(next_tick) => break,
                Some(cmd) = cmd_rx.recv() => {
                    let prev_scale = time_scale;
                    apply_command(
                        cmd,
                        &mut pipeline,
                        &mut time_scale,
                        &mut time_scale_updated_at_seconds,
                        &mut injections,
                        injection_default_ttl,
                        probe_count,
                    );
                    if time_scale != prev_scale {
                        next_tick = last_tick + tick_interval(time_scale);
                    }
                }
            }
        }

        // Drain any remaining latched writes that arrived right at the tick boundary, so every
        // queued write is applied before this tick runs (latched, not mid-tick).
        while let Ok(cmd) = cmd_rx.try_recv() {
            apply_command(
                cmd,
                &mut pipeline,
                &mut time_scale,
                &mut time_scale_updated_at_seconds,
                &mut injections,
                injection_default_ttl,
                probe_count,
            );
        }
        prune_injections(&mut injections, &mut pipeline, probe_count);

        let tick_start = std::time::Instant::now();
        let snapshot = pipeline.tick();
        last_tick = tokio::time::Instant::now();
        metrics.record_tick(tick_start.elapsed(), &snapshot, time_scale);
        next_tick = last_tick + tick_interval(time_scale);
        let meta = ViewMeta {
            time_scale,
            time_scale_updated_at_seconds,
            override_timeout,
            injection_default_ttl,
            probe_count,
            base,
        };
        let view = build_view(&pipeline, &snapshot, &meta, &injections);
        let _ = view_tx.send_replace(view);
        metrics.record_publish(publisher.publish_snapshot(&snapshot, time_scale));
    }
}

/// Spawn the background task that samples this process's CPU/memory into `metrics` every
/// [`RESOURCE_SAMPLE_PERIOD`]. A reused [`sysinfo::System`] lets sysinfo compute CPU as a delta
/// since the previous refresh (the first sample reports 0% while it seeds the baseline).
fn spawn_resource_sampler(metrics: Arc<crate::metrics::Metrics>) {
    let pid = match sysinfo::get_current_pid() {
        Ok(pid) => pid,
        Err(err) => {
            tracing::warn!("resource metrics disabled: cannot resolve current pid: {err}");
            return;
        }
    };
    tokio::spawn(async move {
        let mut sys = sysinfo::System::new();
        loop {
            if let Some((cpu_percent, resident_bytes)) =
                crate::metrics::sample_current_process(&mut sys, pid)
            {
                metrics.set_process_usage(cpu_percent, resident_bytes);
            }
            tokio::time::sleep(RESOURCE_SAMPLE_PERIOD).await;
        }
    });
}

/// Apply one latched command to the pipeline + sim registries.
fn apply_command(
    cmd: Command,
    pipeline: &mut Pipeline<SimulatedHal>,
    time_scale: &mut f64,
    time_scale_updated_at_seconds: &mut u64,
    injections: &mut HashMap<InjectionKey, InjectionRecord>,
    injection_default_ttl: u64,
    probe_count: usize,
) {
    match cmd {
        Command::SetSetpoints(sp) => pipeline.apply_setpoints(*sp),
        Command::SetZone(zone) => pipeline.apply_zone(*zone),
        Command::SetOverride {
            id,
            level,
            ttl_secs,
        } => {
            let clock = pipeline.clock().clone();
            pipeline.overrides_mut().set(id, level, &clock, ttl_secs);
        }
        Command::ClearOverride(id) => pipeline.overrides_mut().clear(&id),
        Command::InjectSensor(spec) => {
            let now = pipeline.clock().sim_seconds();
            let ttl = spec.ttl_secs.unwrap_or(injection_default_ttl);
            for channel in channels_for(&spec.key, probe_count) {
                pipeline
                    .hal_mut()
                    .inject_sensor(channel, spec.value, spec.ttl_secs);
            }
            injections.insert(
                spec.key,
                InjectionRecord {
                    value: spec.value,
                    created_at_seconds: now,
                    expires_at_seconds: now.saturating_add(ttl),
                },
            );
        }
        Command::ClearInjection(key) => {
            for channel in channels_for(&key, probe_count) {
                pipeline.hal_mut().clear_sensor_injection(&channel);
            }
            injections.retain(|k, _| !(k.metric == key.metric && k.zone_id == key.zone_id));
        }
        Command::SetTimeScale(scale) => {
            *time_scale = scale;
            pipeline.hal_mut().set_time_scale(scale);
            *time_scale_updated_at_seconds = pipeline.clock().sim_seconds();
        }
    }
}

/// Drop injections whose deadline has passed, clearing them from the HAL too (mirrors the HAL's own
/// TTL so the listing and the effect expire together).
fn prune_injections(
    injections: &mut HashMap<InjectionKey, InjectionRecord>,
    pipeline: &mut Pipeline<SimulatedHal>,
    probe_count: usize,
) {
    let now = pipeline.clock().sim_seconds();
    let expired: Vec<InjectionKey> = injections
        .iter()
        .filter(|(_, rec)| rec.expires_at_seconds <= now)
        .map(|(k, _)| k.clone())
        .collect();
    for key in expired {
        for channel in channels_for(&key, probe_count) {
            pipeline.hal_mut().clear_sensor_injection(&channel);
        }
        injections.remove(&key);
    }
}

/// The raw HAL channels an injection key maps to (temperature with no probe → all probes).
fn channels_for(key: &InjectionKey, probe_count: usize) -> Vec<SensorChannel> {
    match key.metric.as_str() {
        "temperature" => match key.probe_index {
            Some(i) => vec![SensorChannel::TemperatureProbe(i)],
            None => (0..probe_count)
                .map(SensorChannel::TemperatureProbe)
                .collect(),
        },
        "humidity" => vec![SensorChannel::Humidity],
        "co2" => vec![SensorChannel::Co2],
        "par" => vec![SensorChannel::Par],
        "soil_moisture" => key
            .zone_id
            .clone()
            .map(|z| vec![SensorChannel::SoilMoisture(z)])
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Scalar metadata for building a [`RuntimeView`].
struct ViewMeta {
    time_scale: f64,
    time_scale_updated_at_seconds: u64,
    override_timeout: u64,
    injection_default_ttl: u64,
    probe_count: usize,
    base: DateTime<Utc>,
}

/// Build the REST read model from the latest committed snapshot + pipeline state.
fn build_view(
    pipeline: &Pipeline<SimulatedHal>,
    snapshot: &Snapshot,
    meta: &ViewMeta,
    injections: &HashMap<InjectionKey, InjectionRecord>,
) -> RuntimeView {
    let base = meta.base;
    // tick_index → simulated-instant offset for converting stored deadlines.
    let offset = snapshot.sim_seconds.saturating_sub(snapshot.tick_index);

    let zone_configs: Vec<_> = pipeline.zones().to_vec();
    let zones = zone_configs
        .iter()
        .map(|zone| {
            let soil = snapshot
                .trusted
                .soil_moisture
                .get(&zone.id)
                .copied()
                .flatten();
            let irrigating = snapshot.commanded.get(&ActuatorId::Valve(zone.id.clone())) > 0.0;
            let faulted = soil.is_none()
                || snapshot
                    .faults
                    .iter()
                    .any(|f| f.zone_id.as_ref() == Some(&zone.id));
            let last_cycle_ts = pipeline
                .zone_runtime(&zone.id)
                .and_then(|(_, last)| last)
                .map(|tick| instant_ts(base, offset + tick));
            ZoneStatusDto {
                zone_id: zone.id.as_str().to_string(),
                moisture_low_threshold: zone.moisture_low_threshold,
                moisture_high_threshold: zone.moisture_high_threshold,
                drain_period_secs: zone.drain_period_secs,
                schedule: zone.schedule.to_string(),
                soil_moisture_vwc: soil,
                irrigating,
                faulted,
                last_cycle_ts,
            }
        })
        .collect();

    let health = HealthDto {
        mode: snapshot.mode,
        healthy: snapshot.healthy(),
        faults: snapshot
            .faults
            .iter()
            .map(|f| FaultSummaryDto {
                component: f.component.clone(),
                zone_id: f.zone_id.as_ref().map(|z| z.as_str().to_string()),
                fault_type: f.fault_type,
                severity: f.severity,
            })
            .collect(),
        ts: instant_ts(base, snapshot.sim_seconds),
    };

    let overrides = snapshot
        .overrides
        .iter()
        .map(|(id, ov)| {
            let (actuator, zone_id) = match id {
                ActuatorId::House(a) => (*a, None),
                ActuatorId::Valve(z) => (
                    crate::domain::Actuator::IrrigationValve,
                    Some(z.as_str().to_string()),
                ),
            };
            OverrideDto {
                actuator: actuator_name(actuator).to_string(),
                zone_id,
                state: OutputState::new(actuator, ov.level),
                created_at: instant_ts(base, offset + ov.created_at_tick),
                expires_at: Some(instant_ts(base, offset + ov.expires_at_tick)),
            }
        })
        .collect();

    let injection_dtos = injections
        .iter()
        .map(|(key, rec)| SensorInjectionDto {
            metric: key.metric.clone(),
            value: rec.value,
            probe_index: key.probe_index,
            zone_id: key.zone_id.as_ref().map(Slug::as_str).map(str::to_string),
            created_at: instant_ts(base, rec.created_at_seconds),
            expires_at: Some(instant_ts(base, rec.expires_at_seconds)),
        })
        .collect();

    RuntimeView {
        setpoints: pipeline.setpoints().clone(),
        zone_configs,
        zones,
        health,
        overrides,
        injections: injection_dtos,
        time_scale: meta.time_scale,
        tick_index: snapshot.tick_index,
        sim_seconds: snapshot.sim_seconds,
        time_scale_updated_at_seconds: meta.time_scale_updated_at_seconds,
        override_timeout_secs: meta.override_timeout,
        injection_default_ttl_secs: meta.injection_default_ttl,
        probe_count: meta.probe_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_interval_scales_inversely_with_speed() {
        use std::time::Duration;
        assert_eq!(tick_interval(1.0), Duration::from_millis(1000));
        assert_eq!(tick_interval(2.0), Duration::from_millis(500));
        assert_eq!(tick_interval(0.5), Duration::from_millis(2000));
        assert_eq!(tick_interval(4.0), Duration::from_millis(250));
        // Never zero, even at absurd speeds.
        assert!(tick_interval(100_000.0) >= Duration::from_millis(1));
    }

    /// The control loop's scheduling primitive: a time-scale change recomputes the tick deadline
    /// from the last tick, so a speed-up arriving mid-wait fires the next tick on the *new* cadence
    /// immediately instead of waiting out the old slow interval ([interfaces §3]).
    #[tokio::test(start_paused = true)]
    async fn time_scale_speedup_shortens_the_pending_wait() {
        let (tx, mut rx) = mpsc::channel::<f64>(4);
        let last_tick = tokio::time::Instant::now();
        let mut next_tick = last_tick + tick_interval(0.5); // 2000 ms at 0.5×

        // 100 ms into the (would-be 2000 ms) wait, a speed-up to 4× arrives.
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = tx.send(4.0).await;
        });

        let fired_after;
        loop {
            tokio::select! {
                biased;
                () = tokio::time::sleep_until(next_tick) => {
                    fired_after = last_tick.elapsed();
                    break;
                }
                Some(scale) = rx.recv() => {
                    next_tick = last_tick + tick_interval(scale); // recompute from the last tick
                }
            }
        }

        // 4× → 250 ms interval; the tick fires ~250 ms in, far short of the original 2000 ms.
        assert!(
            fired_after < std::time::Duration::from_millis(500),
            "tick fired after {fired_after:?}; a speed-up must not wait out the old interval"
        );
    }
}
