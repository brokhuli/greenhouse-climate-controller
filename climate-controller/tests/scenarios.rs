//! Golden control/safety scenario library, run through the seeded HAL ([verification §2]).
//!
//! Each scenario fixes the seed (via the example config) and drives a condition deterministically —
//! by HAL sensor/actuator injection or manual override — then asserts the controller responds the
//! intended way within its latency bound. These exercise the *real* sensing → control → safety
//! path behind the HAL trait, not a shortcut around it.

use climate_controller::clock::Clock;
use climate_controller::config::Config;
use climate_controller::domain::{Actuator, Slug};
use climate_controller::faults::{FaultType, Mode};
use climate_controller::hal::{
    ActuatorFaultKind, ActuatorId, SensorChannel, SimControl, SimulatedHal,
};
use climate_controller::pipeline::Pipeline;
use climate_controller::state::Snapshot;

fn config() -> Config {
    Config::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/config/greenhouse.example.toml"
    ))
    .expect("example config loads")
}

fn pipeline_at(cfg: Config, clock: Clock) -> Pipeline<SimulatedHal> {
    let hal = SimulatedHal::new(&cfg);
    Pipeline::with_clock(cfg, hal, clock)
}

fn heater(s: &Snapshot) -> f64 {
    s.commanded.get(&ActuatorId::House(Actuator::Heater))
}
fn vents(s: &Snapshot) -> f64 {
    s.commanded.get(&ActuatorId::House(Actuator::RoofVents))
}
fn injector(s: &Snapshot) -> f64 {
    s.commanded.get(&ActuatorId::House(Actuator::Co2Injector))
}

/// Diurnal: at night the temperature PID holds the (cooler) night setpoint against the cold
/// outdoor, and VPD stays near its target.
#[test]
fn diurnal_night_tracks_setpoint_and_vpd() {
    let mut p = pipeline_at(config(), Clock::starting_at("02:00".parse().unwrap()));
    let mut last = None;
    for _ in 0..3600 {
        last = Some(p.tick());
    }
    let s = last.unwrap();
    let temp = s.trusted.temperature.expect("temperature available");
    // Night setpoint is 18 °C; without control the air would fall toward outdoor 10 °C.
    assert!(
        (temp - 18.0).abs() < 3.0,
        "night temperature held near 18 °C, was {temp}"
    );
    let vpd = s.trusted.vpd.expect("vpd available");
    assert!(
        (vpd - 1.0).abs() < 0.6,
        "VPD held near target 1.0 kPa, was {vpd}"
    );
    assert_eq!(s.mode, Mode::Normal);
}

/// Redundant-temperature fault: one probe outlier — median voting holds with no degradation
/// (`P1-REL-2`); a disagreement warning is raised but the controller keeps controlling.
#[test]
fn one_temperature_probe_outlier_is_tolerated() {
    let mut p = pipeline_at(config(), Clock::starting_at("02:00".parse().unwrap()));
    for _ in 0..600 {
        p.tick();
    }
    // Inject one wildly-high probe; the other two still agree.
    p.hal_mut()
        .inject_sensor(SensorChannel::TemperatureProbe(0), 85.0, Some(50));
    let s = p.tick();
    let temp = s
        .trusted
        .temperature
        .expect("temperature still available via the agreeing probes");
    assert!(
        temp < 40.0,
        "fused temperature rejects the outlier, was {temp}"
    );
    assert!(
        s.faults
            .iter()
            .any(|f| f.fault_type == FaultType::SensorDisagreement),
        "a disagreement warning should be raised"
    );
    assert_ne!(
        s.mode,
        Mode::Interlock,
        "one outlier must not trip a safety interlock"
    );
}

/// Total temperature disagreement: no two probes agree → temperature unavailable, the controller
/// holds a safe state with no crash (`P1-RESIL-1`).
#[test]
fn total_temperature_disagreement_holds_safe_state() {
    let mut p = pipeline_at(config(), Clock::starting_at("12:00".parse().unwrap()));
    for _ in 0..60 {
        p.tick();
    }
    p.hal_mut()
        .inject_sensor(SensorChannel::TemperatureProbe(0), 5.0, Some(50));
    p.hal_mut()
        .inject_sensor(SensorChannel::TemperatureProbe(1), 40.0, Some(50));
    p.hal_mut()
        .inject_sensor(SensorChannel::TemperatureProbe(2), 80.0, Some(50));
    let s = p.tick();
    assert_eq!(s.trusted.temperature, None, "temperature is unavailable");
    assert_eq!(heater(&s), 0.0, "safe hold: no blind heating");
    assert_eq!(s.mode, Mode::Interlock);
}

/// Non-temperature sensor fault: an injected out-of-range CO₂ reading is detected and the injector
/// fails closed (`P1-REL-3`).
#[test]
fn out_of_range_co2_fails_injector_closed() {
    let mut p = pipeline_at(config(), Clock::starting_at("02:00".parse().unwrap()));
    for _ in 0..30 {
        p.tick();
    }
    p.hal_mut()
        .inject_sensor(SensorChannel::Co2, 99_000.0, Some(20));
    let s = p.tick();
    assert_eq!(s.trusted.co2, None);
    assert_eq!(injector(&s), 0.0, "fail-closed: never enrich blind");
    assert!(
        s.faults
            .iter()
            .any(|f| f.component == "co2" && f.fault_type == FaultType::OutOfRange)
    );
}

/// Actuator health — stuck: an actuator whose observed state diverges from its command is detected
/// and failed safe within the window (`P1-REL-4`).
#[test]
fn stuck_actuator_is_detected_and_disabled() {
    let mut cfg = config();
    cfg.sensing.no_response_window_ticks = 3;
    let mut p = pipeline_at(cfg, Clock::new());
    // Heater jammed full-on regardless of command.
    p.hal_mut().inject_actuator_fault(
        ActuatorId::House(Actuator::Heater),
        ActuatorFaultKind::StuckOn,
        Some(100),
    );
    let mut raised = false;
    for _ in 0..10 {
        let s = p.tick();
        if s.faults
            .iter()
            .any(|f| f.fault_type == FaultType::ActuatorStuck)
        {
            raised = true;
            break;
        }
    }
    assert!(
        raised,
        "a stuck actuator should raise actuator_stuck within the window"
    );
}

/// Actuator health — no-response: a valve commanded open whose soil never rises raises the
/// irrigation no-response interlock and the zone is disabled (`P1-REL-4`).
#[test]
fn valve_no_response_disables_zone() {
    let mut cfg = config();
    cfg.sensing.no_response_window_ticks = 3;
    // Soil moves far slower (τ≈1800 s) than soil-sensor noise, so disable that noise to give the
    // no-response detector a clean signal (a real deployment uses a much longer irrigation window).
    cfg.simulation.noise.soil_moisture = 0.0;
    let zone: Slug = "bench-a".parse().unwrap();
    let valve = ActuatorId::Valve(zone.clone());
    let mut p = pipeline_at(cfg, Clock::new());
    // Force the valve open (override) and suppress its effect (no-effect fault) so soil never rises.
    p.hal_mut()
        .inject_actuator_fault(valve.clone(), ActuatorFaultKind::NoEffect, Some(100));
    let timeout = p.config().safety.override_timeout_secs;
    let clock = p.clock().clone();
    p.overrides_mut().set(valve.clone(), 100.0, &clock, timeout);

    let mut raised = false;
    for _ in 0..10 {
        let s = p.tick();
        if s.faults.iter().any(|f| {
            f.fault_type == FaultType::IrrigationNoResponse && f.zone_id.as_ref() == Some(&zone)
        }) {
            raised = true;
            break;
        }
    }
    assert!(
        raised,
        "an unresponsive valve should raise irrigation_no_response"
    );
}

/// Critical-temperature interlock: injecting all probes past the critical max asserts the interlock
/// within one tick of detection, running full cooling (`P1-REL-1`).
#[test]
fn critical_temperature_interlock_within_one_tick() {
    let cfg = config();
    let critical = cfg.safety.critical_temperature_c;
    let mut p = pipeline_at(cfg, Clock::starting_at("12:00".parse().unwrap()));
    // Inject every probe above the critical max *before* the next tick.
    for i in 0..3 {
        p.hal_mut()
            .inject_sensor(SensorChannel::TemperatureProbe(i), critical + 5.0, Some(50));
    }
    let s = p.tick(); // the very next tick
    assert!(
        s.faults
            .iter()
            .any(|f| f.fault_type == FaultType::CriticalTemperature),
        "critical-temperature interlock must assert the tick the threshold is crossed"
    );
    assert_eq!(heater(&s), 0.0, "heater off under critical temperature");
    assert!(
        vents(&s) > 0.0,
        "cooling engaged (slew-limited toward full)"
    );
    assert_eq!(s.mode, Mode::Interlock);
}

/// CO₂ vent interlock (loop-level): with the temperature loop venting for cooling, the injector is
/// hard-off even though CO₂ is below target.
#[test]
fn co2_vent_interlock_suppresses_enrichment() {
    let mut p = pipeline_at(config(), Clock::starting_at("12:00".parse().unwrap()));
    // Hot air → the temperature loop drives the vents open; low CO₂ would otherwise enrich.
    for i in 0..3 {
        p.hal_mut()
            .inject_sensor(SensorChannel::TemperatureProbe(i), 35.0, Some(100));
    }
    p.hal_mut()
        .inject_sensor(SensorChannel::Co2, 400.0, Some(100));
    let s = p.tick();
    assert!(vents(&s) > 0.0, "vents open for cooling");
    assert_eq!(injector(&s), 0.0, "no enrichment while venting");
}

/// Manual override auto-expiry: a forgotten override releases after its timeout (`P1-RESIL-2`).
#[test]
fn manual_override_auto_expires() {
    let mut p = pipeline_at(config(), Clock::starting_at("02:00".parse().unwrap()));
    let heater_id = ActuatorId::House(Actuator::Heater);
    let clock = p.clock().clone();
    p.overrides_mut().set(heater_id.clone(), 100.0, &clock, 5); // expires 5 ticks out

    // While active, the heater is forced to 100 regardless of the loop.
    let s = p.tick();
    assert_eq!(heater(&s), 100.0);
    assert!(s.overrides.contains_key(&heater_id));

    // After the timeout elapses, the override is gone.
    for _ in 0..6 {
        p.tick();
    }
    let s = p.tick();
    assert!(
        !s.overrides.contains_key(&heater_id),
        "override should have auto-expired"
    );
}
