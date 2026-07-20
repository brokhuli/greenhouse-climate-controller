# Optimizer (Phase 3)

AI-driven climate optimizer — **Python (FastAPI)**.

Pulls historical data from Phase 2, simulates greenhouse dynamics (NumPy/SciPy), uses an LLM
to plan refined climate **setpoints** (targets, never actuator commands), validates them against a
constraint engine, and submits them to Phase 2's single-authority setpoint write API — which
reconciles them to the controller (RFC-005). It writes setpoints only: MQTT is telemetry-only and is
never a command path, and the optimizer never writes to controllers directly. Conforms to the schemas
in `../contracts/`.

## Status — deterministic core (slice 1)

This first slice is the LLM-free, fully-testable foundation. The LLM planner, the FastAPI service,
the scheduler, and the Docker Compose services land in later slices.

- `src/climate_optimizer/`
  - `config.py` — typed service configuration (`pydantic-settings`) mirroring the spec-11 keys.
  - `models/` — Pydantic v2 domain models mirroring the wire contracts (`OptimizerPlan` / `PlanRecord`,
    `PlanningContext`, `Setpoints`).
  - `schema_validation.py` — offline JSON-Schema validation against `../contracts/`.
  - `gating.py` — the input data-quality / freshness gate (spec 07).
  - `params.py` + `twin.py` — the digital twin: a seeded, closed-form exponential forward model
    (spec 03), with divergence and fidelity-residual checks.
  - `constraints.py` — the constraint engine + auto-apply / escalation gate (spec 06).
  - `dataaccess.py` — the async Phase-2 read/write client.
- `tests/` — the pytest suite.
- `prompts/` — checked-in, versioned planner prompt templates (added with the planner slice).

## Development

`uv` manages the environment and the committed `uv.lock`; the interpreter is pinned by
`.python-version`. Run the format / lint / typecheck / test gate (CLAUDE.md) from this directory:

```
uv sync
uv run ruff format      # format
uv run ruff check       # lint
uv run mypy             # typecheck
uv run pytest           # test
```
