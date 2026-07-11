# Optimizer — Tech Stack

> **Purpose:** The recommended optimizer dependency set, going one level deeper than
> [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only),
> which fixes only the load-bearing choices (Python · FastAPI · LangChain · NumPy/SciPy ·
> httpx). Each entry states **what** it is, **why** it's chosen over alternatives, and **how**
> it's used here. Choices are constrained by the
> [NFR doc](../../artifacts/non-functional-requirements.md)
> (`P3-PERF-2` LLM call < 60 s; `P3-MOD-1` backend-agnostic invocation; `P3-TEST-1` every plan
> through the constraint engine; `P3-REL-1`/`P3-RESIL-1`/`P3-AVAIL-1` optimizer failure never
> disrupts control; `P3-SCAL-1` one greenhouse at a time; `P3-OBS-1` `optimizer_run_id` tracing;
> `P3-SEC-1` API key via secret, never logged; `P3-PORT-1` Python under Compose, no cloud) and by
> the [scope boundary](./13-spec-optimizer-scope.md). Host tooling (Python install, Ollama, editor
> LSP) is in
> [`required-dependencies.md`](../required-dependencies.md#phase-3--local-llm-climate-optimizer).

> **High-stakes picks are flagged ⚑** — the **Phase 2 data-access layer** and the **digital-twin
> integrator** are the two choices most worth a second look before locking; each lists its
> alternatives and the trip-wire that would change the decision. The service framework and the LLM
> integration are fixed upstream ([tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only),
> [RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)).

---

## Core language & runtime

### Python — `python`

- **What:** The optimizer service language.
- **Why:** Fixed by
  [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only).
  Python is the natural home for the LLM, simulation, and constraint-solving libraries this layer
  leans on; "flexible by design — this layer evolves as LLM capabilities do."
- **How:** One service, run under Docker Compose (`P3-PORT-1`). The interpreter version is **pinned**
  via `.python-version` so container and dev builds match — the Python analog of the controller's
  `rust-toolchain.toml` and the platform's Go module version.

### uv — dependency & environment manager

- **What:** A single fast tool for the virtual-environment, the lockfile, and installs.
- **Why:** [required-dependencies.md](../required-dependencies.md#phase-3--local-llm-climate-optimizer)
  calls for "a project virtual-environment/dependency manager" without fixing one; `uv` resolves and
  installs from a committed `uv.lock`, giving the same reproducible, one-command bootstrap the Rust
  (`cargo`) and Go (modules) phases already have, in one tool rather than a `pip` + `venv` +
  `pip-tools` stack.
- **How:** `pyproject.toml` declares dependencies; `uv.lock` pins the exact resolution; `uv sync`
  provisions the env and `uv run` executes the format/lint/typecheck/test gate and the service. Exact
  version pins live in `pyproject.toml` / `uv.lock`, not in this prose.

---

## Service framework

### FastAPI + Uvicorn + Pydantic v2 — `fastapi`, `uvicorn`, `pydantic`

- **What:** The ASGI service framework (FastAPI on Uvicorn) and its validation layer (Pydantic v2).
- **Why:** FastAPI is fixed by
  [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only)
  and the [ADR](../../../decisions/architecture-design-record.md): Pydantic's declarative
  request/response validation lines up with the `OptimizerPlan` Pydantic model the planner already
  emits ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)) and with the wire
  schemas in [`contracts/`](../../../../contracts/), and its async model fits the LLM- and
  HTTP-bound I/O.
- **How:** Serves the operator surface from
  [interfaces](./10-spec-optimizer-interfaces.md) — trigger planning cycles, inspect proposed plans,
  and review/act on escalations (`P3-USE-1`). Pydantic models mirror the contract schemas so a
  malformed request or plan fails at the boundary, not mid-cycle.

---

## LLM planning

### LangChain — `langchain-anthropic`, `langchain-openai`, `langchain-community`

- **What:** The planner's chain composition, chat-model wrappers, structured-output parsing, and
  fallback routing.
- **Why:** Fixed by
  [RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
  (revised 2026-06-11, [ADR](../../../decisions/architecture-design-record.md)). LangChain's
  `Runnable` chain, `ChatPromptTemplate`, `.with_structured_output(OptimizerPlan)`, and
  `.with_fallbacks()` replace bespoke prompt construction, output parsing, and try/catch failover —
  keeping the invocation strategy **backend-agnostic** (`P3-MOD-1`).
- **How:** The planner is the chain `ChatPromptTemplate | LLM | StructuredOutputParser`
  ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)). The active wrapper is chosen
  by configuration: `ChatOllama` is the **default** local backend, with `ChatAnthropic` / `ChatOpenAI`
  available as opt-in cloud backends; an optional secondary is wired via `.with_fallbacks([...])`.
  Sampling is **pinned** — default model `llama3` (a cloud model such as `claude-sonnet-4-6` when a
  cloud provider is configured), temperature `0`, `top_p 1.0`, `max_tokens` from
  [configuration](./11-spec-optimizer-configuration.md) — so plans are reproducible enough to
  regression-test ([planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)).
  A model or provider change is a reviewed **ADR event**, never a silent upgrade; any configured fallback
  is a different model held to its own evaluation baseline, and failover is logged and traced by
  `optimizer_run_id` (`P3-OBS-1`). Cloud API keys are supplied via `PLANNER_API_KEY` and **never logged**
  (`P3-SEC-1`).

---

## Simulation / digital twin ⚑

### NumPy + SciPy — `numpy`, `scipy`

- **What:** The numerical core of the forward climate model.
- **Why:** Fixed by
  [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only).
  The twin integrates coupled heat / humidity / CO₂ / VPD / DLI dynamics with actuator lag
  ([digital twin §1](./03-spec-optimizer-digital-twin.md#1-the-forward-model)) — exactly the ODE /
  array workload NumPy + SciPy exist for.
- **How ⚑:** The integrator is SciPy's `solve_ivp` run with a **bounded step**
  (`twin.solver_max_step_minutes`, [configuration](./11-spec-optimizer-configuration.md)) and a
  **seed**, with the per-step non-finite / physical-plausibility / non-convergence checks from
  [digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity). A seeded, fixed-step
  solver is what makes the twin a **reproducible** forward model — the optimizer-side analog of the
  controller's seeded HAL (`P1-TEST-2`,
  [controller HAL — determinism](../controller/03-spec-controller-hal-simulation.md#7-determinism--seeding))
  — which the evaluation suite ([evaluation](./08-spec-optimizer-evaluation.md), `P3-TEST-1`) relies
  on. **⚑ Alternatives & trip-wire:** a **hand-rolled RK step** (more code to vet for the same
  behavior) or a **stiff/implicit specialized solver** (JiTCODE, assimulo). Reach past
  `solve_ivp` only if the greenhouse dynamics prove stiff enough that a bounded explicit step can't
  hold plausibility without an impractically small step.

---

## Data access (Phase 2 REST read API) ⚑

### httpx — `httpx`

- **What:** The HTTP client for the optimizer's read path into Phase 2.
- **Why:** The revised
  [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) makes the
  telemetry read path a platform REST contract for consistency with the rest of the system. The
  platform may use internal SQL views or continuous aggregates behind that endpoint, but the optimizer
  stays decoupled from Postgres schema details. `httpx` is async-native and shares the FastAPI service
  model.
- **How:** Reads planning context, historical telemetry, actuator states, current setpoints, and
  data-quality/freshness signals for one greenhouse from Phase 2
  ([interfaces](./10-spec-optimizer-interfaces.md)); `platform_api_url` comes from
  [configuration](./11-spec-optimizer-configuration.md). The hourly `(min, mean, max)` summaries the
  planner context needs may still be computed by TimescaleDB internal views or continuous aggregates,
  but that is a platform implementation detail.
- **⚑ Alternatives & trip-wire:** **Direct SQL via SQLAlchemy/psycopg** (faster and closer to
  TimescaleDB, but inconsistent with the rest of the system's REST contract posture and exposes a DB
  integration boundary); **replicating telemetry into an optimizer-owned store** (duplicates Phase 2's
  storage/retention problem). Revisit direct SQL only if REST serialization or query shaping becomes a
  measured bottleneck.

---

## Phase 2 write path

### httpx — `httpx`

- **What:** The same HTTP client also submits refined setpoints to Phase 2.
- **Why:** The write path is a single small `POST`, so a full client stack is unwarranted.
- **How:** Writes refined setpoint bundles via `POST /api/greenhouses/{id}/setpoints`
  ([interfaces](./10-spec-optimizer-interfaces.md)); Phase 2 remains the single authority and
  reconciles to the controller ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
  In `trusted_network` mode the call is untokened; in `oidc` mode it presents the Keycloak
  client-credentials `Bearer` token carrying the narrow `setpoints:write` service role
  ([interfaces — authenticating the write path](./10-spec-optimizer-interfaces.md#authenticating-the-phase-2-write-path),
  [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)).
  The client secret is `PLANNER_OIDC_CLIENT_SECRET`, from env only (`P3-SEC-1`).

---

## Configuration

### pydantic-settings — `pydantic-settings`

- **What:** Environment-variable → typed-settings binding.
- **Why:** The optimizer is configured via **environment variables / the Compose file**, not a
  per-greenhouse TOML ([configuration](./11-spec-optimizer-configuration.md)); `pydantic-settings`
  binds those env vars to typed, validated settings and **fails fast at load** on a bad value — the
  Python analog of the controller's `serde` + `toml` boundary validation.
- **How:** Loads the Phase 2 endpoint and its service-auth mode, LLM provider / model /
  sampling, objective weights, the local time-of-use cost schedule, and the data-quality, twin,
  application-gate, and service thresholds. Secrets (`PLANNER_API_KEY`,
  `PLANNER_OIDC_CLIENT_SECRET`) resolve from env only and are never written to a file or a log
  (`P3-SEC-1`).

---

## Contract validation

### `jsonschema` + `referencing`

- **What:** JSON Schema validation of the payloads the optimizer reads and the structured plan it
  emits.
- **Why:** The optimizer **consumes** the shared contracts rather than redefining them
  ([spec conventions](../spec-conventions.md)); validating against the same
  [`contracts/`](../../../../contracts/) schemas (JSON Schema 2020-12) the controller and platform
  validate against keeps the whole system contract-first. A `referencing.Registry` resolves the
  schemas' `$id`s **offline**, matching the rest of the stack's no-network validation.
- **How:** The emitted `OptimizerPlan` and the read payloads are checked at the boundary; the Pydantic
  model mirrors the contract schema, so validation is a guard, not a second source of truth.

---

## Observability

### Structured logging (`logging`, JSON) + `prometheus-client`

- **What:** Structured operational logs plus a Prometheus `/metrics` surface.
- **Why:** `P3-OBS-1` requires every applied or escalated plan to be **traceable by
  `optimizer_run_id`**, and planner failover / twin divergence are logged and traced
  ([planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility),
  [digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity)). Stdlib `logging`
  with a JSON handler needs no extra dependency and mirrors the platform's `slog` stream
  ([platform tech stack](../platform/10-spec-platform-tech-stack.md)).
- **How:** Each cycle logs a JSON record carrying `optimizer_run_id`, the input-gate / twin outcome,
  and whether the plan was applied or escalated. `prometheus-client` exposes a **`/metrics`** surface
  on the optimizer's FastAPI service ([interfaces §9](./10-spec-optimizer-interfaces.md)) — *optimizer-health*
  (cycle rate/duration, twin divergence, planner failover, applied-vs-escalated), the metrics sibling
  of its `/health` endpoint. It joins the platform's shared Prometheus/Grafana
  ([platform operations §1](../platform/08-spec-platform-operations.md#1-observability)) as a third
  scrape target, the same way each controller does. The exporter lands with the optimizer itself in
  Phase 3, not the 2b platform slice; the surface is defined here so the observability story is whole.

---

## Testing

- **What:** `pytest` unit tests plus the evaluation / regression suites of
  [§08](./08-spec-optimizer-evaluation.md).
- **Why:** `P3-TEST-1` requires **100% of plans through the deterministic constraint engine**; the
  regression suite diffs plans against the **seeded twin** and the **pinned planner**, which is why
  determinism is designed into both ([digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
  [planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)).
- **How:** Unit tests cover the constraint engine, the input-quality gate
  ([input gating](./07-spec-optimizer-input-gating.md)), and the context serializer's token-budget
  behavior (`P3-PERF-3`); a LangChain fake / recorded chat model keeps planner tests off a live LLM;
  golden-scenario runs drive the seeded twin and assert plan stability. Coverage runs in CI.

---

## Tooling

- **ruff** — formatting **and** linting; runs in CI. Maps the
  [CLAUDE.md](../../../../CLAUDE.md) format + lint gate to Python (`ruff format`, `ruff check`).
- **mypy** — static type-checking (the typecheck gate).
- **pytest** — the test gate; see [Testing](#testing).
- **uv** — drives all of the above (`uv run ruff …`, `uv run mypy`, `uv run pytest`), matching the
  Phase 3 row of [`spec-verification.md`](../spec-verification.md).
- **Docker / Docker Compose** — the service and its default local Ollama backend run as Compose services
  (`P3-PORT-1`); see [Deployment](#deployment).

---

## Deployment

- **What:** An `optimizer` service and an `ollama` service in Docker Compose.
- **Why:** `P3-PORT-1` — the optimizer runs as a Python service under Compose with **no cloud
  account**, which the default local Ollama backend satisfies out of the box. A cloud LLM, when
  configured, is reached through Docker Desktop's default outbound internet access; the local `ollama`
  container is the **default** backend and needs no API key or network egress.
- **How:** The `optimizer` service is configured entirely by environment / secret
  ([configuration](./11-spec-optimizer-configuration.md)); the `ollama` service backs the default
  `endpoint` (`http://ollama:11434`). The optimizer is a **client** of Phase 2
  ([architecture](./02-spec-optimizer-architecture.md)) — it reads and writes through
  Phase 2's API; it opens **no** channel to a Phase 1 controller.

---

## Explicitly rejected

Recorded so the choice isn't re-litigated:

- **Flask / Django for the service** — FastAPI's Pydantic/contract alignment and async fit are the
  reason it was chosen ([ADR](../../../decisions/architecture-design-record.md)); a second web
  framework buys nothing.
- **A bespoke LLM client (manual prompt construction, output parsing, try/catch failover)** —
  superseded by LangChain per
  [RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
  (revised).
- **A direct DB client (SQLAlchemy / psycopg / asyncpg) as the default** — the optimizer reads Phase
  2 through REST; internal SQL views remain platform implementation detail.
- **Poetry, or raw `pip` + `venv` + `pip-tools`** — `uv` is the chosen single, lockfile-first tool;
  the others are slower or more moving parts for the same result.
- **Direct MQTT setpoint publish / a second channel to the Phase 1 controller** — all downward
  influence flows through the Phase 2 REST API
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain));
  the optimizer opens no controller channel.
- **Replicating telemetry into an optimizer-owned store** — rejected by
  [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path); the
  optimizer reads the platform-owned history through Phase 2's REST API.
- **A vector database / LLM-ops platform** — planning is stateless per cycle against a fixed token
  budget ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)); there is no retrieval
  corpus to index.
