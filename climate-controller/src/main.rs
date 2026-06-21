//! Controller entry point.
//!
//! Loads + validates the TOML config (path from the first CLI argument, default
//! `config/greenhouse.example.toml`), then runs the async [`runtime`](climate_controller::runtime):
//! the fixed-tick pipeline over the simulated HAL, publishing telemetry over MQTT and serving the
//! REST control surface. The controller runs until the process is stopped.

use std::process::ExitCode;

use climate_controller::config::Config;
use climate_controller::runtime;

const DEFAULT_CONFIG_PATH: &str = "config/greenhouse.example.toml";

#[tokio::main]
async fn main() -> ExitCode {
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
        "loaded config from {path}"
    );

    match runtime::run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("runtime error: {err}");
            ExitCode::FAILURE
        }
    }
}
