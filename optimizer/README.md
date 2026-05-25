# Optimizer (Phase 3)

AI-driven climate optimizer — **Python (FastAPI)**.

Pulls historical data from Phase 2, simulates greenhouse dynamics (NumPy/SciPy), uses an LLM
to generate actuator plans, validates them against a constraint engine, and delivers plans via
MQTT or the Phase 2 API. Conforms to the schemas in `../contracts/`.

- `src/` — optimizer source.
- `tests/` — pytest suite.

Python project (`pyproject.toml`) is added in a later step.
