# Optimizer (Phase 3)

AI-driven climate optimizer — **Python (FastAPI)**.

Pulls historical data from Phase 2, simulates greenhouse dynamics (NumPy/SciPy), uses an LLM
to plan refined climate **setpoints** (targets, never actuator commands), validates them against a
constraint engine, and submits them to Phase 2's single-authority setpoint write API — which
reconciles them to the controller (RFC-005). It writes setpoints only: MQTT is telemetry-only and is
never a command path, and the optimizer never writes to controllers directly. Conforms to the schemas
in `../contracts/`.

## Status — deterministic core + service

The planning cycle runs end-to-end inside this service, and the platform now serves both sides of
the Phase 2 boundary it needs: the `GET /planning-context` read handler and the `/api/optimizer/*`
operator proxy/aggregate (Go). The **operator console (React)** has since landed in
`../climate-frontend` (`src/features/optimizer/` — the `/optimizer` view, the per-greenhouse plan
panel, and the fleet-card status pill, polled over the Go `/api/optimizer/*` surface). The service is
now **containerized and wired into the local stack**: the `optimizer` and a local `ollama` backend run
under Docker Compose, reached through the platform proxy (see [Running in the stack](#running-in-the-stack)
and [`deploy/README.md`](../deploy/README.md#phase-3-optimizer)).

**The deterministic core** — LLM-free and independently testable:

- `config.py` — typed service configuration (`pydantic-settings`) mirroring the spec-11 keys.
- `models/` — Pydantic v2 domain models mirroring the wire contracts (`OptimizerPlan` / `PlanRecord`,
  `PlanningContext`, `Setpoints`).
- `schema_validation.py` — offline JSON-Schema validation against `../contracts/`.
- `gating.py` — the input data-quality / freshness gate (spec 07).
- `params.py` + `twin.py` — the digital twin: a seeded, closed-form exponential forward model
  (spec 03), with divergence and fidelity-residual checks.
- `constraints.py` — the constraint engine + auto-apply / escalation gate (spec 06).
- `dataaccess.py` — the async Phase-2 read/write client.

**The service** — the planning loop and the operator surface built on that core:

- `planner/` — the LLM planner (spec 04): the plan-context serializer and its hard token budget, the
  LangChain `ChatPromptTemplate | LLM | StructuredOutputParser` chain with provider wrappers and
  fallback routing, the state-change gate, and the adaptive horizon.
- `prompts/planner.v1.md` — the checked-in, versioned planner prompt, pinned by `prompt_version`.
  A released template is immutable: a change ships `planner.v2.md` and bumps the pin.
- `cycle.py` — one greenhouse's pass through read → gate → simulate → plan → validate → apply,
  emitting a `PlanRecord` on every branch (spec 05).
- `scheduler.py` — the fixed-cadence loop (concurrent across greenhouses, single-flight within one,
  gated on the enable flags) plus the independent escalation sweep (spec 02, spec 09).
- `store.py` — in-memory plan records, the escalation lifecycle (dedup, supersede, TTL, retention),
  and the per-greenhouse cross-cycle memory. Nothing here survives a restart, by design (spec 09).
- `runtime.py` — the three operator-mutable settings (`enabled` service-wide and per-greenhouse,
  and the active `model`), all in-memory and reset from config on restart.
- `auth.py` — the Keycloak client-credentials token for the Phase-2 write path, and the inbound
  operator-role gate. Both dormant under the default `trusted_network` posture (RFC-011).
- `service/` — the FastAPI app: `GET /health`, `GET /metrics`, and the `/api/optimizer/*` operator
  endpoints (spec 10), with fail-fast configuration validation at startup.
- `metrics.py` / `logging.py` — the Prometheus collectors and the structured JSON log stream.
- `tests/` — the pytest suite; the planner is exercised through an injected fake chain, so no test
  needs a live LLM.

## Running the service

Configuration is entirely environment-driven (`OPTIMIZER_*`, plus the `PLANNER_*` secrets); an
invalid config blocks startup rather than running on silent defaults.

```
uv run python -m climate_optimizer      # serves on :8000
```

## Running in the stack

In the local Docker stack the service runs as the `optimizer` container against a local `ollama` model,
built from [`Dockerfile`](./Dockerfile). Bring it up with the rest of the stack via
`bash deploy/scripts/fresh-run.sh` (which also pulls the model), and reach the operator console at
`http://localhost:8080/optimizer`. The shared `contracts/` are bind-mounted read-only at `/contracts`
(`CLIMATE_OPTIMIZER_CONTRACTS_DIR`) rather than baked into the image. Full deployment notes — model
selection, GPU, memory — are in [`deploy/README.md`](../deploy/README.md#phase-3-optimizer).

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
