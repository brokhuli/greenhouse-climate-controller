//! climate-controller — Phase 1 greenhouse climate controller.
//!
//! The crate is organized as the [tick pipeline](pipeline) ([architecture §2]) over a
//! [HAL](hal) seam: each tick the pipeline reads simulated sensors, [fuses + fault-checks](sensing)
//! them, resolves setpoints + runs the [control loops](control), applies [manual override](overrides)
//! and [safety guardrails](safety), and drives the HAL — all on a deterministic [virtual clock](clock).
//! The [configuration layer](config) is loaded and validated from TOML at startup.
//!
//! The crate wires the **deterministic pipeline core** to its I/O edges: the [MQTT publisher](mqtt)
//! (telemetry out), the [REST server](rest) (the sole inbound write path), and the
//! [async runtime/scheduler](runtime) that drives the tick loop.

pub mod clock;
pub mod config;
pub mod control;
pub mod domain;
pub mod faults;
pub mod hal;
pub mod mqtt;
pub mod overrides;
pub mod pipeline;
pub mod rest;
pub mod rng;
pub mod runtime;
pub mod safety;
pub mod sensing;
pub mod state;
pub mod telemetry;
pub mod validation;
