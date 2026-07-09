# Optimizer (Phase 3)

AI-driven climate optimizer — **Python (FastAPI)**.

Pulls historical data from Phase 2, simulates greenhouse dynamics (NumPy/SciPy), uses an LLM
to plan refined climate **setpoints** (targets, never actuator commands), validates them against a
constraint engine, and submits them to Phase 2's single-authority setpoint write API — which
reconciles them to the controller (RFC-005). It writes setpoints only: MQTT is telemetry-only and is
never a command path, and the optimizer never writes to controllers directly. Conforms to the schemas
in `../contracts/`.

- `src/` — optimizer source.
- `tests/` — pytest suite.

Python project (`pyproject.toml`) is added in a later step.
