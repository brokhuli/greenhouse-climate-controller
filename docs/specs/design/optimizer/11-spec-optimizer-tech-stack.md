# Optimizer — Tech Stack

> **Purpose:** The recommended optimizer dependency set, going one level deeper than
> [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only),
> which fixes only the load-bearing choices (Python · FastAPI · LangChain · NumPy/SciPy ·
> SQLAlchemy). Each entry states **what** it is, **why** it's chosen over alternatives, and **how**
> it's used here. Choices are constrained by the
> [NFR doc](../../artifacts/non-functional-requirements.md)
> (`P3-PERF-2` LLM call < 60 s; `P3-MOD-1` backend-agnostic invocation; `P3-TEST-1` every plan
> through the constraint engine; `P3-REL-1`/`P3-RESIL-1`/`P3-AVAIL-1` optimizer failure never
> disrupts control; `P3-SCAL-1` one greenhouse at a time; `P3-OBS-1` `optimizer_run_id` tracing;
> `P3-SEC-1` API key via secret, never logged; `P3-PORT-1` Python under Compose, no cloud) and by
> the [scope boundary](./12-spec-optimizer-scope.md). Host tooling (Python install, Ollama, editor
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
  request/response validation lines up with the `ActuatorPlan` Pydantic model the planner already
  emits ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)) and with the wire
  schemas in [`contracts/`](../../../../contracts/), and its async model fits the LLM- and
  HTTP-bound I/O.
- **How:** Serves the operator surface from
  [interfaces](./09-spec-optimizer-interfaces.md) — trigger planning cycles, inspect proposed plans,
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
  `Runnable` chain, `ChatPromptTemplate`, `.with_structured_output(ActuatorPlan)`, and
  `.with_fallbacks()` replace bespoke prompt construction, output parsing, and try/catch failover —
  keeping the invocation strategy **backend-agnostic** (`P3-MOD-1`).
- **How:** The planner is the chain `ChatPromptTemplate | LLM | StructuredOutputParser`
  ([planning §1](./04-spec-optimizer-planning.md#1-llm-driven-planning)) with `ChatAnthropic` /
  `ChatOpenAI` primary and `ChatOllama` wired via `.with_fallbacks([ChatOllama(...)])`. Sampling is
  **pinned** — primary model `claude-sonnet-4-6`, temperature `0`, `top_p 1.0`, `max_tokens` from
  [configuration](./10-spec-optimizer-configuration.md) — so plans are reproducible enough to
  regression-test ([planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)).
  A model change is a reviewed **ADR event**, never a silent upgrade; the Ollama `llama3` fallback is
  a different model held to its own evaluation baseline, and failover is logged and traced by
  `optimizer_run_id` (`P3-OBS-1`). The API key is supplied via `PLANNER_API_KEY` and **never logged**
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
  (`twin.solver_max_step_minutes`, [configuration](./10-spec-optimizer-configuration.md)) and a
  **seed**, with the per-step non-finite / physical-plausibility / non-convergence checks from
  [digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity). A seeded, fixed-step
  solver is what makes the twin a **reproducible** forward model — the optimizer-side analog of the
  controller's seeded HAL (`P1-TEST-2`,
  [controller HAL — determinism](../controller/03-spec-controller-hal-simulation.md#7-determinism--seeding))
  — which the evaluation suite ([evaluation](./07-spec-optimizer-evaluation.md), `P3-TEST-1`) relies
  on. **⚑ Alternatives & trip-wire:** a **hand-rolled RK step** (more code to vet for the same
  behavior) or a **stiff/implicit specialized solver** (JiTCODE, assimulo). Reach past
  `solve_ivp` only if the greenhouse dynamics prove stiff enough that a bounded explicit step can't
  hold plausibility without an impractically small step.

---

## Data access (Phase 2 store) ⚑

### SQLAlchemy Core + psycopg (v3), sync — `sqlalchemy`, `psycopg`

- **What:** The read path into Phase 2's TimescaleDB.
- **Why:** SQLAlchemy is fixed by
  [tech-stack-decisions.md](../tech-stack-decisions.md#phase-3--llm-climate-optimizer-python-only);
  the driver and the sync-vs-async decision are the discretionary part. Per
  [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) the
  optimizer connects as the dedicated `optimizer_ro` role with `SELECT`-only grants on a small set
  of named **views** (not the raw hypertables). SQLAlchemy **Core** (expression language, not the
  ORM) keeps that SQL explicit against the versioned view surface, mirroring the platform's
  no-ORM / hand-written-`pgx` discipline
  ([platform tech stack](../platform/10-spec-platform-tech-stack.md)).
- **How:** Reads historical telemetry, actuator states, and current setpoints for one greenhouse
  ([interfaces](./09-spec-optimizer-interfaces.md)); the DSN comes from
  [configuration](./10-spec-optimizer-configuration.md) and the connection **never writes**. The
  hourly `(min, mean, max)` summaries the planner context needs may be served by a TimescaleDB
  continuous aggregate exposed through the read surface (`RFC-008`), so the reduction happens in the
  store rather than in Python.
- **⚑ Alternatives & trip-wire:** **asyncpg / async SQLAlchemy** (unnecessary — reads are periodic
  on the 30-minute cycle cadence, not latency-bound, so a sync driver keeps the read path simple);
  **the SQLAlchemy ORM** (obscures the view contract this layer is deliberately coupled to); **raw
  `psycopg` without SQLAlchemy** (loses pooling and parameter-binding niceties). Revisit async only
  if the read workload ever becomes latency-bound.

---

## Phase 2 write path

### httpx — `httpx`

- **What:** The HTTP client that submits refined setpoints to Phase 2.
- **Why:** `httpx` is async-native and shares the service's async model; the write path is a single
  small `POST`, so a full client stack is unwarranted.
- **How:** Writes refined setpoint bundles via `POST /greenhouses/{id}/setpoints`
  ([interfaces](./09-spec-optimizer-interfaces.md)); Phase 2 remains the single authority and
  reconciles to the controller ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
  In `trusted_network` mode the call is untokened; in `oidc` mode it presents the Keycloak
  client-credentials `Bearer` token carrying the narrow `setpoints:write` service role
  ([interfaces — authenticating the write path](./09-spec-optimizer-interfaces.md#authenticating-the-phase-2-write-path),
  [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)).
  The client secret is `PLANNER_OIDC_CLIENT_SECRET`, from env only (`P3-SEC-1`).

---

## Configuration

### pydantic-settings — `pydantic-settings`

- **What:** Environment-variable → typed-settings binding.
- **Why:** The optimizer is configured via **environment variables / the Compose file**, not a
  per-greenhouse TOML ([configuration](./10-spec-optimizer-configuration.md)); `pydantic-settings`
  binds those env vars to typed, validated settings and **fails fast at load** on a bad value — the
  Python analog of the controller's `serde` + `toml` boundary validation.
- **How:** Loads the DSN, the Phase 2 endpoint and its service-auth mode, LLM provider / model /
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
- **How:** The emitted `ActuatorPlan` and the read payloads are checked at the boundary; the Pydantic
  model mirrors the contract schema, so validation is a guard, not a second source of truth.

---

## Observability

### Structured logging (`logging`, JSON) + optional `prometheus-client`

- **What:** Structured operational logs and, optionally, a `/metrics` surface.
- **Why:** `P3-OBS-1` requires every applied or escalated plan to be **traceable by
  `optimizer_run_id`**, and planner failover / twin divergence are logged and traced
  ([planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility),
  [digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity)). Stdlib `logging`
  with a JSON handler needs no extra dependency and mirrors the platform's `slog` stream
  ([platform tech stack](../platform/10-spec-platform-tech-stack.md)).
- **How:** Each cycle logs a JSON record carrying `optimizer_run_id`, the input-gate / twin outcome,
  and whether the plan was applied or escalated. `prometheus-client` is **optional** and deferred
  alongside the platform's 2b observability stack, not a Phase 3 baseline requirement.

---

## Testing

- **What:** `pytest` unit tests plus the evaluation / regression suites of
  [§07](./07-spec-optimizer-evaluation.md).
- **Why:** `P3-TEST-1` requires **100% of plans through the deterministic constraint engine**; the
  regression suite diffs plans against the **seeded twin** and the **pinned planner**, which is why
  determinism is designed into both ([digital twin §2](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
  [planning — determinism](./04-spec-optimizer-planning.md#determinism--reproducibility)).
- **How:** Unit tests cover the constraint engine, the input-quality gate
  ([input gating](./06-spec-optimizer-input-gating.md)), and the context serializer's token-budget
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
- **Docker / Docker Compose** — the service and its Ollama fallback run as Compose services
  (`P3-PORT-1`); see [Deployment](#deployment).

---

## Deployment

- **What:** An `optimizer` service and an `ollama` service in Docker Compose.
- **Why:** `P3-PORT-1` — the optimizer runs as a Python service under Compose with **no cloud
  account**. The hosted LLM is reached through Docker Desktop's default outbound internet access; the
  local `ollama` container provides the offline fallback backend.
- **How:** The `optimizer` service is configured entirely by environment / secret
  ([configuration](./10-spec-optimizer-configuration.md)); the `ollama` service backs
  `fallback_endpoint` (`http://ollama:11434`). The optimizer is a **client** of Phase 2
  ([architecture](./02-spec-optimizer-architecture.md)) — it reads Phase 2's store and writes through
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
- **An ORM (SQLAlchemy ORM / Django ORM) for reads** — the read surface is a few versioned views;
  SQLAlchemy Core keeps the SQL explicit, mirroring the platform's no-ORM stance.
- **An async DB driver (asyncpg) as the default** — reads are periodic and not latency-bound; sync
  `psycopg` is simpler (see [Data access ⚑](#data-access-phase-2-store-)).
- **Poetry, or raw `pip` + `venv` + `pip-tools`** — `uv` is the chosen single, lockfile-first tool;
  the others are slower or more moving parts for the same result.
- **Direct MQTT setpoint publish / a second channel to the Phase 1 controller** — all downward
  influence flows through the Phase 2 REST API
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain));
  the optimizer opens no controller channel.
- **Replicating telemetry into an optimizer-owned store** — rejected by
  [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path); the
  optimizer reads directly via `SELECT` on Phase 2's views.
- **A vector database / LLM-ops platform** — planning is stateless per cycle against a fixed token
  budget ([planning](./04-spec-optimizer-planning.md#1-llm-driven-planning)); there is no retrieval
  corpus to index.
