//! End-to-end pipeline integration test ([verification §4]).
//!
//! Exercises the full path behind the HAL trait — seed → sense → fuse → resolve → control →
//! interlock → constrain → drive — asserting the committed snapshot agrees with the commanded
//! actuator state, that an injected fault surfaces within one tick (the `/health` analog,
//! `P1-OBS-2`), and that the run is deterministic (`P1-TEST-2`).

use climate_controller::config::Config;
use climate_controller::faults::FaultType;
use climate_controller::hal::{SensorChannel, SimControl, SimulatedHal};
use climate_controller::pipeline::Pipeline;

fn config() -> Config {
    Config::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/config/greenhouse.example.toml"
    ))
    .expect("example config loads")
}

fn pipeline() -> Pipeline<SimulatedHal> {
    let cfg = config();
    let hal = SimulatedHal::new(&cfg);
    Pipeline::new(cfg, hal)
}

#[test]
fn nominal_run_is_healthy_and_observed_tracks_commanded() {
    let mut p = pipeline();
    for _ in 0..120 {
        let s = p.tick();
        assert!(s.healthy(), "no faults expected nominally: {:?}", s.faults);
        // With no actuator faults injected, the observed readback equals the command.
        assert_eq!(
            s.commanded, s.observed,
            "observed actuator state should match commanded in the fault-free case"
        );
    }
}

#[test]
fn injected_fault_surfaces_in_health_within_one_tick() {
    let mut p = pipeline();
    for _ in 0..30 {
        let s = p.tick();
        assert!(s.healthy());
    }
    // Force an out-of-range humidity reading; the very next tick must reflect it.
    p.hal_mut()
        .inject_sensor(SensorChannel::Humidity, 250.0, Some(20));
    let s = p.tick();
    assert!(
        !s.healthy(),
        "an injected fault must make the controller unhealthy"
    );
    assert!(
        s.faults
            .iter()
            .any(|f| f.component == "humidity" && f.fault_type == FaultType::OutOfRange),
        "the humidity out-of-range fault should surface within one tick"
    );
}

#[test]
fn run_is_deterministic_under_seed() {
    let mut a = pipeline();
    let mut b = pipeline();
    for _ in 0..300 {
        let sa = a.tick();
        let sb = b.tick();
        assert_eq!(sa.commanded, sb.commanded);
        assert_eq!(sa.observed, sb.observed);
        assert_eq!(sa.trusted, sb.trusted);
    }
}
