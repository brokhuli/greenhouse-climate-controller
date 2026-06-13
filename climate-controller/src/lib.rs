//! climate-controller — Phase 1 greenhouse climate controller.
//!
//! This slice implements the **configuration layer**: typed structs loaded and validated from
//! a TOML file (controller spec §4, §3, §9, §13). Runtime behavior — the HAL, sensor fusion,
//! control loops, safety interlocks, and the MQTT/REST interfaces — lands in later slices and
//! consumes the [`config::Config`] produced here.

pub mod config;
pub mod domain;
pub mod validation;
