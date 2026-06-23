# Greenhouse Climate Controller

## Overview
A local, containerized greenhouse automation and intelligence platform. Phase 1 is a
deterministic real-time Rust controller with a hardware abstraction layer over simulated
sensors and actuators, PID and rule-based control, safety interlocks, and MQTT/REST
interfaces (headless — no local UI). Later phases add a local PaaS (Go + TimescaleDB) whose
React frontend is the system's only dashboard, and an AI climate optimizer (Python).

## Development Commands

Phase 1 is the Rust controller; Phase 2a is the Go platform backend; the cross-component
contracts are validated with a Node harness. Python (Phase 3) commands arrive with their phase.
The full verification strategy and per-phase tooling matrix is
[`spec-verification.md`](docs/specs/design/spec-verification.md).

```sh
# format
cargo fmt --manifest-path climate-controller/Cargo.toml --all

# lint
cargo clippy --manifest-path climate-controller/Cargo.toml --all-targets --all-features -- -D warnings

# typecheck
cargo check --manifest-path climate-controller/Cargo.toml --all-targets

# test
cargo test --manifest-path climate-controller/Cargo.toml

# build
cargo build --manifest-path climate-controller/Cargo.toml

# --- Phase 2a platform (Go) — run from climate-platform/ ---
# format / lint / vet / build / unit test
gofmt -w climate-platform; (cd climate-platform && golangci-lint run ./... && go vet ./... && go build ./... && go test ./...)
# DB-backed integration tests (TimescaleDB via testcontainers; needs Docker)
(cd climate-platform && go test -tags integration ./test/... -timeout 360s)

# validate cross-component contracts (schemas + fixtures + OpenAPI lint)
npm install && npm run validate:contracts
```

These run automatically in the [pre-commit hook](.githooks/pre-commit): the Rust gate when
`climate-controller/` is touched, the contracts gate when `contracts/` is touched. The Go gate
(format, lint, vet, build, unit tests) and a TimescaleDB integration job run in
[CI](.github/workflows/ci.yml). Bring up the full local stack (broker + DB + API + N simulated
controllers) per [`deploy/README.md`](deploy/README.md).
