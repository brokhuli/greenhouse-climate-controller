# Controller (Phase 1)

Deterministic real-time greenhouse climate controller — **Rust**.

Hardware abstraction layer over simulated sensors (temp, humidity, CO₂, soil moisture) and
actuators (fan, heater, vents, misters, irrigation, grow lights), with PID loops, a rule
engine, safety interlocks, and fault detection. Publishes telemetry and consumes actuator
commands over MQTT per the schemas in `../contracts/`.

- `src/` — controller source (unit tests live inline via `#[cfg(test)]`).
- `tests/` — Cargo integration tests.

The Cargo project (`Cargo.toml`, `rust-toolchain.toml`) is bootstrapped alongside the spec before implementation begins.
