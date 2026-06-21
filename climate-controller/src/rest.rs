//! REST API — the sole inbound write path ([interfaces §3], `contracts/controller-rest/`).
//!
//! Reads come from a snapshot [`RuntimeView`] the tick task publishes each tick; writes are
//! **latched**: a handler validates synchronously (returning `422` with the violated bound on
//! failure, mirroring the contract `ValidationError`) and otherwise enqueues a [`Command`] the tick
//! task applies on the **next** tick ([architecture §3]). All paths are greenhouse-scoped; a path
//! `greenhouse_id` that is not this controller's returns `404`. The API is unauthenticated (the
//! Docker network is the trust boundary, RFC-009). The simulation endpoints are diagnostic
//! ([interfaces §3 simulation]).

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::config::{Setpoints, Zone};
use crate::domain::{Actuator, Slug, TimeOfDay};
use crate::faults::{FaultType, Mode, Severity};
use crate::hal::ActuatorId;
use crate::telemetry::{OutputState, actuator_name, instant_ts, is_on_off};
use crate::validation::FieldViolation;

// ───────────────────────────── write model (REST → tick task) ─────────────────────────────

/// A latched runtime mutation the tick task applies at the next tick boundary.
#[derive(Debug, Clone)]
pub enum Command {
    /// Replace the global setpoints (already validated).
    SetSetpoints(Box<Setpoints>),
    /// Replace a zone's runtime config (already validated).
    SetZone(Box<Zone>),
    /// Force an actuator to a level for `ttl_secs` simulated seconds.
    SetOverride {
        /// Target actuator.
        id: ActuatorId,
        /// Forced level 0–100.
        level: f64,
        /// Auto-expiry in simulated seconds.
        ttl_secs: u64,
    },
    /// Clear an actuator override.
    ClearOverride(ActuatorId),
    /// Inject a sensor reading (simulated HAL).
    InjectSensor(InjectionSpec),
    /// Clear a sensor injection.
    ClearInjection(InjectionKey),
    /// Set the simulated clock's time-scale.
    SetTimeScale(f64),
}

/// Identifies an injection for the registry/DTO (metric + optional probe/zone selector).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InjectionKey {
    /// Injected metric (`temperature`/`humidity`/`co2`/`par`/`soil_moisture`).
    pub metric: String,
    /// Temperature probe index, or `None` for "all probes".
    pub probe_index: Option<usize>,
    /// Target zone for `soil_moisture`.
    pub zone_id: Option<Slug>,
}

/// A full injection request (key + forced value + optional TTL).
#[derive(Debug, Clone)]
pub struct InjectionSpec {
    /// What to inject.
    pub key: InjectionKey,
    /// Forced value.
    pub value: f64,
    /// Auto-expiry in simulated seconds, or `None` for the configured default.
    pub ttl_secs: Option<u64>,
}

// ───────────────────────────── read model (tick task → REST) ─────────────────────────────

/// The snapshot the REST layer renders GETs from, refreshed by the tick task each tick.
#[derive(Debug, Clone)]
pub struct RuntimeView {
    /// Current global setpoints (serializes directly as the contract `Setpoints`).
    pub setpoints: Setpoints,
    /// Raw zone configs (for rebuilding a `Zone` to validate a PATCH).
    pub zone_configs: Vec<Zone>,
    /// Per-zone status.
    pub zones: Vec<ZoneStatusDto>,
    /// Controller health.
    pub health: HealthDto,
    /// Active manual overrides.
    pub overrides: Vec<OverrideDto>,
    /// Active sensor injections.
    pub injections: Vec<SensorInjectionDto>,
    /// Active time-scale.
    pub time_scale: f64,
    /// Current tick index.
    pub tick_index: u64,
    /// Simulated seconds at the latest tick (for timestamps).
    pub sim_seconds: u64,
    /// Simulated seconds when the time-scale was last set.
    pub time_scale_updated_at_seconds: u64,
    /// Default override auto-expiry (simulated seconds).
    pub override_timeout_secs: u64,
    /// Default injection auto-expiry (simulated seconds).
    pub injection_default_ttl_secs: u64,
    /// Number of redundant temperature probes (for injection validation).
    pub probe_count: usize,
}

// ───────────────────────────── response DTOs (mirror the contract) ─────────────────────────────

/// A zone's config plus live state (contract `ZoneStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneStatusDto {
    /// Zone id.
    pub zone_id: String,
    /// Irrigation trigger threshold (VWC).
    pub moisture_low_threshold: f64,
    /// Irrigation stop threshold (VWC).
    pub moisture_high_threshold: f64,
    /// Minimum gap between cycles (s).
    pub drain_period_secs: u64,
    /// Comma-separated HH:MM schedule.
    pub schedule: String,
    /// Latest soil-moisture reading, or null when faulted.
    pub soil_moisture_vwc: Option<f64>,
    /// Whether the valve is currently open.
    pub irrigating: bool,
    /// Whether this zone's irrigation is disabled by a fault.
    pub faulted: bool,
    /// End of the most recent cycle (RFC 3339), or null.
    pub last_cycle_ts: Option<String>,
}

/// A single active fault (contract `FaultSummary`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaultSummaryDto {
    /// Faulted component.
    pub component: String,
    /// Zone for a zone-local fault.
    pub zone_id: Option<String>,
    /// Fault type.
    pub fault_type: FaultType,
    /// Severity.
    pub severity: Severity,
}

/// Controller mode + active faults (contract `Health`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthDto {
    /// Operating mode.
    pub mode: Mode,
    /// False when any fault is active.
    pub healthy: bool,
    /// Active fault summaries.
    pub faults: Vec<FaultSummaryDto>,
    /// When this snapshot was produced (RFC 3339).
    pub ts: String,
}

/// An active manual override (contract `Override`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverrideDto {
    /// Actuator name.
    pub actuator: String,
    /// Zone for a per-zone actuator.
    pub zone_id: Option<String>,
    /// Forced output state.
    pub state: OutputState,
    /// When set (RFC 3339).
    pub created_at: String,
    /// When it auto-expires (RFC 3339), or null.
    pub expires_at: Option<String>,
}

/// An active sensor injection (contract `SensorInjection`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorInjectionDto {
    /// Injected metric.
    pub metric: String,
    /// Forced value.
    pub value: f64,
    /// Forced probe, or null.
    pub probe_index: Option<usize>,
    /// Target zone, or null.
    pub zone_id: Option<String>,
    /// When set (RFC 3339).
    pub created_at: String,
    /// When it auto-expires (RFC 3339), or null.
    pub expires_at: Option<String>,
}

/// Time-scale state (contract `TimeScale`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeScaleDto {
    /// Active wall-clock cadence multiplier.
    pub scale: f64,
    /// Current tick counter.
    pub tick_index: u64,
    /// When the scale was last set (RFC 3339).
    pub updated_at: String,
}

// ───────────────────────────── request DTOs ─────────────────────────────

/// Partial setpoints update (contract `SetpointsPatch`).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetpointsPatch {
    temperature_day_c: Option<f64>,
    temperature_night_c: Option<f64>,
    day_start: Option<String>,
    day_end: Option<String>,
    humidity_low_pct: Option<f64>,
    humidity_high_pct: Option<f64>,
    humidity_deadband_pct: Option<f64>,
    co2_target_ppm: Option<u32>,
    co2_vent_interlock_threshold_pct: Option<f64>,
    vpd_target_kpa: Option<f64>,
    dli_target_mol: Option<f64>,
}

impl SetpointsPatch {
    fn is_empty(&self) -> bool {
        self.temperature_day_c.is_none()
            && self.temperature_night_c.is_none()
            && self.day_start.is_none()
            && self.day_end.is_none()
            && self.humidity_low_pct.is_none()
            && self.humidity_high_pct.is_none()
            && self.humidity_deadband_pct.is_none()
            && self.co2_target_ppm.is_none()
            && self.co2_vent_interlock_threshold_pct.is_none()
            && self.vpd_target_kpa.is_none()
            && self.dli_target_mol.is_none()
    }
}

/// Partial zone-config update (contract `ZoneConfigPatch`).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ZoneConfigPatch {
    moisture_low_threshold: Option<f64>,
    moisture_high_threshold: Option<f64>,
    drain_period_secs: Option<u64>,
    schedule: Option<String>,
}

impl ZoneConfigPatch {
    fn is_empty(&self) -> bool {
        self.moisture_low_threshold.is_none()
            && self.moisture_high_threshold.is_none()
            && self.drain_period_secs.is_none()
            && self.schedule.is_none()
    }
}

/// Force-an-actuator request (contract `OverridePut`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverridePut {
    state: OutputState,
    #[serde(default)]
    ttl_secs: Option<u64>,
    #[serde(default)]
    zone_id: Option<String>,
}

/// Inject-a-reading request (contract `SensorInjectionPut`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SensorInjectionPut {
    value: f64,
    #[serde(default)]
    probe_index: Option<usize>,
    #[serde(default)]
    zone_id: Option<String>,
    #[serde(default)]
    ttl_secs: Option<u64>,
}

/// Set-time-scale request (contract `TimeScalePut`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeScalePut {
    scale: f64,
}

/// Optional `?zone_id=` query selector (DELETE override/injection).
#[derive(Debug, Default, Deserialize)]
pub struct ZoneQuery {
    #[serde(default)]
    zone_id: Option<String>,
}

// ───────────────────────────── app state + router ─────────────────────────────

/// Shared REST state: the controller identity, the command channel, and the read-model receiver.
#[derive(Clone)]
pub struct AppState {
    /// This controller's greenhouse id.
    pub greenhouse_id: Arc<str>,
    /// Latched-write channel to the tick task.
    pub tx: tokio::sync::mpsc::Sender<Command>,
    /// Latest read model.
    pub view: tokio::sync::watch::Receiver<RuntimeView>,
    /// Simulated-clock epoch for timestamps.
    pub base: DateTime<Utc>,
}

impl AppState {
    fn view(&self) -> RuntimeView {
        self.view.borrow().clone()
    }

    fn is_me(&self, greenhouse_id: &str) -> bool {
        greenhouse_id == &*self.greenhouse_id
    }
}

/// Build the controller's REST router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route(
            "/greenhouses/{greenhouse_id}/setpoints",
            get(get_setpoints).patch(patch_setpoints),
        )
        .route("/greenhouses/{greenhouse_id}/zones", get(get_zones))
        .route(
            "/greenhouses/{greenhouse_id}/zones/{zone_id}",
            get(get_zone).patch(patch_zone),
        )
        .route("/greenhouses/{greenhouse_id}/overrides", get(get_overrides))
        .route(
            "/greenhouses/{greenhouse_id}/overrides/{actuator}",
            put(put_override).delete(delete_override),
        )
        .route("/greenhouses/{greenhouse_id}/health", get(get_health))
        .route(
            "/greenhouses/{greenhouse_id}/sim/sensor-injections",
            get(get_injections),
        )
        .route(
            "/greenhouses/{greenhouse_id}/sim/sensor-injections/{metric}",
            put(put_injection).delete(delete_injection),
        )
        .route(
            "/greenhouses/{greenhouse_id}/sim/time-scale",
            get(get_time_scale).put(put_time_scale),
        )
        .with_state(state)
}

// ───────────────────────────── responses ─────────────────────────────

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

fn not_found(message: impl Into<String>) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: message.into(),
        }),
    )
        .into_response()
}

fn unprocessable(violation: FieldViolation) -> Response {
    (StatusCode::UNPROCESSABLE_ENTITY, Json(violation)).into_response()
}

fn ok<T: Serialize>(body: T) -> Response {
    (StatusCode::OK, Json(body)).into_response()
}

// ───────────────────────────── setpoints ─────────────────────────────

async fn get_setpoints(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    ok(s.view().setpoints)
}

async fn patch_setpoints(
    State(s): State<AppState>,
    Path(gh): Path<String>,
    Json(patch): Json<SetpointsPatch>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    if patch.is_empty() {
        return unprocessable(FieldViolation::new(
            "body",
            "at least one field required",
            serde_json::Value::Null,
        ));
    }
    let current = s.view().setpoints;
    let candidate = match apply_setpoints_patch(current, patch) {
        Ok(c) => c,
        Err(v) => return unprocessable(v),
    };
    let _ =
        s.tx.send(Command::SetSetpoints(Box::new(candidate.clone())))
            .await;
    ok(candidate)
}

fn apply_setpoints_patch(
    mut sp: Setpoints,
    patch: SetpointsPatch,
) -> Result<Setpoints, FieldViolation> {
    if let Some(v) = patch.temperature_day_c {
        sp.temperature_day_c = v;
    }
    if let Some(v) = patch.temperature_night_c {
        sp.temperature_night_c = v;
    }
    if let Some(t) = patch.day_start {
        sp.day_start = parse_time(&t, "day_start")?;
    }
    if let Some(t) = patch.day_end {
        sp.day_end = parse_time(&t, "day_end")?;
    }
    if let Some(v) = patch.humidity_low_pct {
        sp.humidity_low_pct = v;
    }
    if let Some(v) = patch.humidity_high_pct {
        sp.humidity_high_pct = v;
    }
    if let Some(v) = patch.humidity_deadband_pct {
        sp.humidity_deadband_pct = v;
    }
    if let Some(v) = patch.co2_target_ppm {
        sp.co2_target_ppm = v;
    }
    if let Some(v) = patch.co2_vent_interlock_threshold_pct {
        sp.co2_vent_interlock_threshold_pct = v;
    }
    if let Some(v) = patch.vpd_target_kpa {
        sp.vpd_target_kpa = v;
    }
    if let Some(v) = patch.dli_target_mol {
        sp.dli_target_mol = v;
    }
    first_violation(|vs| sp.validate(vs)).map_or(Ok(sp), Err)
}

// ───────────────────────────── zones ─────────────────────────────

async fn get_zones(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    ok(s.view().zones)
}

async fn get_zone(
    State(s): State<AppState>,
    Path((gh, zone_id)): Path<(String, String)>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    match s.view().zones.into_iter().find(|z| z.zone_id == zone_id) {
        Some(z) => ok(z),
        None => not_found("unknown zone"),
    }
}

async fn patch_zone(
    State(s): State<AppState>,
    Path((gh, zone_id)): Path<(String, String)>,
    Json(patch): Json<ZoneConfigPatch>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    if patch.is_empty() {
        return unprocessable(FieldViolation::new(
            "body",
            "at least one field required",
            serde_json::Value::Null,
        ));
    }
    let view = s.view();
    // Find the raw Zone config to rebuild, plus its live status for the response.
    let Some(mut zone) = view
        .zone_configs
        .iter()
        .find(|z| z.id.as_str() == zone_id)
        .cloned()
    else {
        return not_found("unknown zone");
    };
    let Some(mut status) = view.zones.iter().find(|z| z.zone_id == zone_id).cloned() else {
        return not_found("unknown zone");
    };

    if let Some(v) = patch.moisture_low_threshold {
        zone.moisture_low_threshold = v;
    }
    if let Some(v) = patch.moisture_high_threshold {
        zone.moisture_high_threshold = v;
    }
    if let Some(v) = patch.drain_period_secs {
        zone.drain_period_secs = v;
    }
    if let Some(sched) = patch.schedule {
        zone.schedule = match sched.parse() {
            Ok(s) => s,
            Err(_) => {
                return unprocessable(FieldViolation::new(
                    "schedule",
                    "comma-separated HH:MM",
                    serde_json::json!(sched),
                ));
            }
        };
    }
    if let Some(v) = first_violation(|vs| zone.validate(vs)) {
        return unprocessable(v);
    }

    // Response = the accepted config merged with the current live fields (write is latched).
    status.moisture_low_threshold = zone.moisture_low_threshold;
    status.moisture_high_threshold = zone.moisture_high_threshold;
    status.drain_period_secs = zone.drain_period_secs;
    status.schedule = zone.schedule.to_string();

    let _ = s.tx.send(Command::SetZone(Box::new(zone))).await;
    ok(status)
}

// ───────────────────────────── overrides ─────────────────────────────

async fn get_overrides(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    ok(s.view().overrides)
}

async fn put_override(
    State(s): State<AppState>,
    Path((gh, actuator)): Path<(String, String)>,
    Json(body): Json<OverridePut>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    let Some(act) = parse_actuator(&actuator) else {
        return not_found("unknown actuator");
    };

    // Validate the output state against the actuator kind.
    if is_on_off(act) && body.state.level_pct.is_some() {
        return unprocessable(FieldViolation::new(
            "level_pct",
            "must be null for an on/off actuator",
            serde_json::json!(body.state.level_pct),
        ));
    }
    if let Some(level) = body.state.level_pct
        && !(0.0..=100.0).contains(&level)
    {
        return unprocessable(FieldViolation::new(
            "level_pct",
            "0..=100",
            serde_json::json!(level),
        ));
    }

    // Resolve the addressable actuator (irrigation_valve needs a zone).
    let view = s.view();
    let id = match act {
        Actuator::IrrigationValve => {
            let Some(zone) = body.zone_id.as_deref().and_then(|z| z.parse::<Slug>().ok()) else {
                return unprocessable(FieldViolation::new(
                    "zone_id",
                    "required for irrigation_valve",
                    serde_json::Value::Null,
                ));
            };
            if !view.zones.iter().any(|z| z.zone_id == zone.as_str()) {
                return unprocessable(FieldViolation::new(
                    "zone_id",
                    "unknown zone",
                    serde_json::json!(zone.as_str()),
                ));
            }
            ActuatorId::Valve(zone)
        }
        other => ActuatorId::House(other),
    };

    let level = override_level(act, &body.state);
    let ttl = body.ttl_secs.unwrap_or(view.override_timeout_secs);
    let _ =
        s.tx.send(Command::SetOverride {
            id: id.clone(),
            level,
            ttl_secs: ttl,
        })
        .await;

    let (actuator_str, zone_id) = match &id {
        ActuatorId::House(a) => (actuator_name(*a), None),
        ActuatorId::Valve(z) => (
            actuator_name(Actuator::IrrigationValve),
            Some(z.as_str().to_string()),
        ),
    };
    ok(OverrideDto {
        actuator: actuator_str.to_string(),
        zone_id,
        state: OutputState::new(act, level),
        created_at: instant_ts(s.base, view.sim_seconds),
        expires_at: Some(instant_ts(s.base, view.sim_seconds + ttl)),
    })
}

async fn delete_override(
    State(s): State<AppState>,
    Path((gh, actuator)): Path<(String, String)>,
    Query(q): Query<ZoneQuery>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    let Some(act) = parse_actuator(&actuator) else {
        return not_found("unknown actuator");
    };
    let id = match act {
        Actuator::IrrigationValve => match q.zone_id.and_then(|z| z.parse::<Slug>().ok()) {
            Some(zone) => ActuatorId::Valve(zone),
            None => return not_found("zone_id required for irrigation_valve"),
        },
        other => ActuatorId::House(other),
    };
    let _ = s.tx.send(Command::ClearOverride(id)).await;
    StatusCode::NO_CONTENT.into_response()
}

// ───────────────────────────── health ─────────────────────────────

async fn get_health(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    ok(s.view().health)
}

// ───────────────────────────── simulation: sensor injection ─────────────────────────────

async fn get_injections(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    ok(s.view().injections)
}

async fn put_injection(
    State(s): State<AppState>,
    Path((gh, metric)): Path<(String, String)>,
    Json(body): Json<SensorInjectionPut>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    if !is_injectable_metric(&metric) {
        return not_found("unknown metric");
    }
    if !body.value.is_finite() {
        return unprocessable(FieldViolation::new(
            "value",
            "must be finite",
            serde_json::Value::Null,
        ));
    }
    let view = s.view();
    // probe_index is temperature-only and must be in range.
    if metric != "temperature" && body.probe_index.is_some() {
        return unprocessable(FieldViolation::new(
            "probe_index",
            "only valid for temperature",
            serde_json::json!(body.probe_index),
        ));
    }
    if let Some(p) = body.probe_index
        && p >= view.probe_count
    {
        return unprocessable(FieldViolation::new(
            "probe_index",
            format!("0..{}", view.probe_count),
            serde_json::json!(p),
        ));
    }
    // soil_moisture is zone-scoped and bounded 0..1; other metrics are house-level.
    let zone_id = if metric == "soil_moisture" {
        let Some(zone) = body.zone_id.as_deref().and_then(|z| z.parse::<Slug>().ok()) else {
            return unprocessable(FieldViolation::new(
                "zone_id",
                "required for soil_moisture",
                serde_json::Value::Null,
            ));
        };
        if !view.zones.iter().any(|z| z.zone_id == zone.as_str()) {
            return unprocessable(FieldViolation::new(
                "zone_id",
                "unknown zone",
                serde_json::json!(zone.as_str()),
            ));
        }
        if !(0.0..=1.0).contains(&body.value) {
            return unprocessable(FieldViolation::new(
                "value",
                "0..=1",
                serde_json::json!(body.value),
            ));
        }
        Some(zone)
    } else {
        None
    };

    let key = InjectionKey {
        metric: metric.clone(),
        probe_index: body.probe_index,
        zone_id: zone_id.clone(),
    };
    let _ =
        s.tx.send(Command::InjectSensor(InjectionSpec {
            key,
            value: body.value,
            ttl_secs: body.ttl_secs,
        }))
        .await;

    let ttl = body.ttl_secs.unwrap_or(view.injection_default_ttl_secs);
    ok(SensorInjectionDto {
        metric,
        value: body.value,
        probe_index: body.probe_index,
        zone_id: zone_id.map(|z| z.as_str().to_string()),
        created_at: instant_ts(s.base, view.sim_seconds),
        expires_at: Some(instant_ts(s.base, view.sim_seconds + ttl)),
    })
}

async fn delete_injection(
    State(s): State<AppState>,
    Path((gh, metric)): Path<(String, String)>,
    Query(q): Query<ZoneQuery>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    if !is_injectable_metric(&metric) {
        return not_found("unknown metric");
    }
    let zone_id = q.zone_id.and_then(|z| z.parse::<Slug>().ok());
    let _ =
        s.tx.send(Command::ClearInjection(InjectionKey {
            metric,
            probe_index: None,
            zone_id,
        }))
        .await;
    StatusCode::NO_CONTENT.into_response()
}

// ───────────────────────────── simulation: time-scale ─────────────────────────────

async fn get_time_scale(State(s): State<AppState>, Path(gh): Path<String>) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    let view = s.view();
    ok(TimeScaleDto {
        scale: view.time_scale,
        tick_index: view.tick_index,
        updated_at: instant_ts(s.base, view.time_scale_updated_at_seconds),
    })
}

async fn put_time_scale(
    State(s): State<AppState>,
    Path(gh): Path<String>,
    Json(body): Json<TimeScalePut>,
) -> Response {
    if !s.is_me(&gh) {
        return not_found("unknown greenhouse");
    }
    if !(0.25..=8.0).contains(&body.scale) {
        return unprocessable(FieldViolation::new(
            "scale",
            "0.25..=8",
            serde_json::json!(body.scale),
        ));
    }
    let _ = s.tx.send(Command::SetTimeScale(body.scale)).await;
    let view = s.view();
    ok(TimeScaleDto {
        scale: body.scale,
        tick_index: view.tick_index,
        updated_at: instant_ts(s.base, view.sim_seconds),
    })
}

// ───────────────────────────── helpers ─────────────────────────────

fn parse_actuator(name: &str) -> Option<Actuator> {
    Some(match name {
        "heater" => Actuator::Heater,
        "fans" => Actuator::Fans,
        "roof_vents" => Actuator::RoofVents,
        "misters" => Actuator::Misters,
        "co2_injector" => Actuator::Co2Injector,
        "grow_lights" => Actuator::GrowLights,
        "shade_screen" => Actuator::ShadeScreen,
        "irrigation_valve" => Actuator::IrrigationValve,
        _ => return None,
    })
}

fn override_level(actuator: Actuator, state: &OutputState) -> f64 {
    if !state.on {
        0.0
    } else if is_on_off(actuator) {
        100.0
    } else {
        state.level_pct.unwrap_or(100.0).clamp(0.0, 100.0)
    }
}

fn is_injectable_metric(metric: &str) -> bool {
    matches!(
        metric,
        "temperature" | "humidity" | "co2" | "par" | "soil_moisture"
    )
}

fn parse_time(value: &str, field: &str) -> Result<TimeOfDay, FieldViolation> {
    value
        .parse()
        .map_err(|_| FieldViolation::new(field, "HH:MM", serde_json::json!(value)))
}

/// Run a validator closure and return its first violation, if any.
fn first_violation(validate: impl FnOnce(&mut Vec<FieldViolation>)) -> Option<FieldViolation> {
    let mut vs = Vec::new();
    validate(&mut vs);
    vs.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_application_validates_bounds_and_invariants() {
        let base: Setpoints = toml::from_str(
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
        .unwrap();

        // Valid partial patch applies.
        let patch = SetpointsPatch {
            temperature_day_c: Some(26.0),
            ..Default::default()
        };
        let updated = apply_setpoints_patch(base.clone(), patch).unwrap();
        assert_eq!(updated.temperature_day_c, 26.0);
        assert_eq!(updated.temperature_night_c, 18.0);

        // Out-of-range is rejected with the violated bound.
        let patch = SetpointsPatch {
            humidity_high_pct: Some(150.0),
            ..Default::default()
        };
        let err = apply_setpoints_patch(base.clone(), patch).unwrap_err();
        assert_eq!(err.field, "humidity_high_pct");

        // Cross-field invariant (low >= high) is rejected.
        let patch = SetpointsPatch {
            humidity_low_pct: Some(90.0),
            ..Default::default()
        };
        let err = apply_setpoints_patch(base, patch).unwrap_err();
        assert_eq!(err.bound, "must be < humidity_high_pct");
    }

    #[test]
    fn override_level_resolves_by_actuator_kind() {
        // On/off actuator → 100 when on, 0 when off.
        let on = OutputState {
            on: true,
            level_pct: None,
        };
        assert_eq!(override_level(Actuator::Misters, &on), 100.0);
        let off = OutputState {
            on: false,
            level_pct: None,
        };
        assert_eq!(override_level(Actuator::Misters, &off), 0.0);
        // Variable actuator → uses level_pct.
        let half = OutputState {
            on: true,
            level_pct: Some(30.0),
        };
        assert_eq!(override_level(Actuator::Fans, &half), 30.0);
    }

    #[test]
    fn parses_all_actuator_names() {
        for name in [
            "heater",
            "fans",
            "roof_vents",
            "misters",
            "co2_injector",
            "grow_lights",
            "shade_screen",
            "irrigation_valve",
        ] {
            assert!(parse_actuator(name).is_some(), "{name}");
        }
        assert!(parse_actuator("bogus").is_none());
    }
}
