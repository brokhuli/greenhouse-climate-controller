# Platform (Phase 2)

Local PaaS platform — **Go (Echo)**.

Ingests telemetry off the MQTT broker, stores time-series data in Postgres/TimescaleDB, and
serves a dashboard API over REST + WebSockets. Conforms to the message schemas in
`../contracts/`.

- `cmd/` — service entrypoints.
- `internal/` — application packages (unit tests live beside code as `*_test.go`).
- `test/` — integration / end-to-end tests.

Go module (`go.mod`) is added in a later step.
