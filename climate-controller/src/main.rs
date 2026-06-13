//! Controller entry point.
//!
//! This slice loads and validates the TOML config (path from the first CLI argument, default
//! `config/greenhouse.example.toml`) and reports what it loaded. The control loop is wired in
//! a later slice.

use std::process::ExitCode;

use climate_controller::config::Config;

const DEFAULT_CONFIG_PATH: &str = "config/greenhouse.example.toml";

fn main() -> ExitCode {
    tracing_subscriber::fmt::init();

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_string());

    match Config::load(&path) {
        Ok(config) => {
            tracing::info!(
                controller_id = %config.controller_id,
                zones = config.zones.len(),
                actuators = config.hal.actuators.len(),
                "loaded config from {path}"
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            tracing::error!("{err}");
            ExitCode::FAILURE
        }
    }
}
