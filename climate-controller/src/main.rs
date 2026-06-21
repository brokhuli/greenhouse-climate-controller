//! Controller entry point.
//!
//! Loads + validates the TOML config (path from the first CLI argument, default
//! `config/greenhouse.example.toml`), then runs the deterministic [`Pipeline`] over the simulated
//! HAL as a synchronous in-process driver, logging a periodic snapshot. The async scheduler (with
//! the `time_scale` cadence), the MQTT publisher, and the REST server are wired in the next slice;
//! this driver lets the control core be exercised end-to-end without any broker or HTTP surface.

use std::process::ExitCode;

use climate_controller::config::Config;
use climate_controller::hal::SimulatedHal;
use climate_controller::pipeline::Pipeline;

const DEFAULT_CONFIG_PATH: &str = "config/greenhouse.example.toml";

/// How many ticks the standalone driver runs (one simulated second each).
const DRIVER_TICKS: u64 = 600;

/// Log a snapshot every this many ticks.
const LOG_EVERY: u64 = 60;

fn main() -> ExitCode {
    tracing_subscriber::fmt::init();

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_string());

    let config = match Config::load(&path) {
        Ok(config) => config,
        Err(err) => {
            tracing::error!("{err}");
            return ExitCode::FAILURE;
        }
    };

    tracing::info!(
        controller_id = %config.controller_id,
        zones = config.zones.len(),
        actuators = config.hal.actuators.len(),
        seed = config.simulation.seed,
        "loaded config from {path}; starting {DRIVER_TICKS}-tick seeded driver"
    );

    let hal = SimulatedHal::new(&config);
    let mut pipeline = Pipeline::new(config, hal);

    for _ in 0..DRIVER_TICKS {
        let snap = pipeline.tick();
        if snap.tick_index % LOG_EVERY == 0 {
            tracing::info!(
                tick = snap.tick_index,
                mode = ?snap.mode,
                temperature_c = snap.trusted.temperature,
                humidity_pct = snap.trusted.humidity,
                co2_ppm = snap.trusted.co2,
                vpd_kpa = snap.trusted.vpd,
                faults = snap.faults.len(),
                "tick"
            );
        }
    }

    tracing::info!("driver complete");
    ExitCode::SUCCESS
}
