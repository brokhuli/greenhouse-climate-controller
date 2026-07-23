# Greenhouse Climate Controller

## Author

Built by Steve Ullom, a software architect focused on real-time control systems,
platform engineering, and practical LLM-enabled applications.

## Overview

A local, containerized greenhouse automation and intelligence platform. The system runs simulated
greenhouse controllers, ingests telemetry into a local platform, serves a React operator dashboard,
and prepares the path for an AI optimizer that proposes safe setpoints.

System flow: Rust controller telemetry flows over MQTT into the Go platform, the dashboard reads the
platform over REST and WebSocket, and setpoints flow back down over REST with the platform as the
single setpoint authority.

## Status

| Area               | Stack                    | Status                                                                                              |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------- |
| Phase 1 controller | Rust                     | Built: simulated HAL, control loops, safety interlocks, MQTT telemetry, REST control API            |
| Phase 2 platform   | Go, Echo, TimescaleDB    | Built through the 2b backbone: ingest, registry, telemetry, profiles, reconciliation, auth, metrics |
| Phase 2 dashboard  | React, TypeScript, Vite  | Built through the 2b UI: fleet, greenhouse detail, setpoints, profiles, activity, auth gating       |
| Phase 3 optimizer  | Python, FastAPI          | Built: deterministic core, LLM planner + scheduler, operator API + console; containerized in the stack (optimizer + local ollama) |
| Contracts          | JSON Schema, OpenAPI 3.1 | Shared source of truth across controller, platform, dashboard, and optimizer boundaries             |

## Architecture

- [`climate-controller/`](climate-controller/README.md): deterministic Rust greenhouse controller
  with a simulated hardware abstraction layer.
- [`climate-platform/`](climate-platform/README.md): Go platform API, MQTT ingest, TimescaleDB
  persistence, reconciliation, auth, and metrics.
- [`climate-frontend/`](climate-frontend/README.md): React dashboard served by the local stack.
- [`climate-optimizer/`](climate-optimizer/README.md): future Python optimizer that reads planning
  context and submits setpoint proposals.
- [`contracts/`](contracts/README.md): MQTT, REST, WebSocket, and optimizer schemas.
- [`deploy/`](deploy/README.md): Docker Compose orchestration for the full local stack.
- [`docs/`](docs/): design specs, decisions, backlog, and verification notes.

## Quick Start

Bring up the full local stack with the MQTT broker, TimescaleDB, Go API, Keycloak, nginx proxy,
React dashboard, and generated simulated controllers:

```sh
# 1. Create local environment settings.
cp deploy/.env.example deploy/.env

# 2. Generate N controller services and configs.
bash deploy/scripts/gen-controllers.sh 2

# 3. Build and start the stack.
docker compose --env-file deploy/.env \
    -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml up -d --build

# 4. Register generated greenhouses with the platform.
bash deploy/controllers/register.sh
```

Open the dashboard at `http://localhost:8080`. Reads are open. Sign in as `operator` / `operator`
to unlock writes, or `viewer` / `viewer` for read-only auth. Full stack operations, reset helpers,
fault injection, observability, and token examples live in [`deploy/README.md`](deploy/README.md).

## Development Commands

Install the root Node dependencies once if you will validate contracts:

```sh
npm install
```

Controller:

```sh
cargo fmt --manifest-path climate-controller/Cargo.toml --all
cargo clippy --manifest-path climate-controller/Cargo.toml --all-targets --all-features -- -D warnings
cargo check --manifest-path climate-controller/Cargo.toml --all-targets
cargo test --manifest-path climate-controller/Cargo.toml
cargo build --manifest-path climate-controller/Cargo.toml
```

Platform:

```sh
cd climate-platform
gofmt -w .
golangci-lint run ./...
go vet ./...
go build ./...
go test ./...
go test -tags integration ./test/... -timeout 360s
```

Frontend:

```sh
cd climate-frontend
npm install
npm run dev
npm run build
npm run lint
npm run typecheck
npm run test
npm run test:e2e
```

Contracts:

```sh
npm run validate:contracts
```

Optimizer (Python, `uv`-managed):

```sh
cd climate-optimizer
uv sync
uv run ruff format      # format
uv run ruff check       # lint
uv run mypy             # typecheck
uv run pytest           # test
uv run python -m climate_optimizer   # serve on :8000 (fully env-driven; see climate-optimizer/README.md)
```

In the local stack the optimizer runs as a container against a local `ollama` LLM — see
[`deploy/README.md`](deploy/README.md#phase-3-optimizer).

## Verification

The full verification strategy and per-phase tooling matrix are in
[`docs/specs/design/spec-verification.md`](docs/specs/design/spec-verification.md).

Local hooks live in [`.githooks/pre-commit`](.githooks/pre-commit). The hook runs the Rust gate when
`climate-controller/` is touched and the contract gate when contract files or the validation harness
are touched. It also bumps the patch version in [`VERSION`](VERSION).

CI in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the Go gate, TimescaleDB-backed
integration tests, frontend checks, Lighthouse CI, Rust checks, and contract validation.

## Key Design Rules

- MQTT is telemetry-only: sensor readings, actuator state, fault events, and system state.
- REST is the only write/control path into controllers.
- The platform is the single setpoint authority and reconciles intended state to controllers.
- The React frontend talks only to the platform API and live WebSocket stream.
- Contracts in [`contracts/`](contracts/README.md) are the shared source of truth for wire behavior.

## Documentation Map

- [`deploy/README.md`](deploy/README.md): run the local stack, auth, observability, reset helpers,
  and fault injection.
- [`contracts/README.md`](contracts/README.md): all cross-component contract families.
- [`docs/specs/design/spec-contracts.md`](docs/specs/design/spec-contracts.md): system contract
  catalog.
- [`docs/specs/design/spec-verification.md`](docs/specs/design/spec-verification.md): verification
  plan and tooling matrix.
- [`docs/decisions/request-for-comments.md`](docs/decisions/request-for-comments.md): project RFCs
  and design decisions.
- [`docs/backlog.md`](docs/backlog.md): implementation backlog and phase tracking.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contribution notes.

## License

See [`LICENSE.md`](LICENSE.md).
