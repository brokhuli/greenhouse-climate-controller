# Non-Functional Requirements

## Performance Testing

The primary performance concern is **platform scalability with controller count** — how the Phase 2
platform behaves as N Phase 1 controllers publish telemetry, receive setpoint updates, and appear in
the fleet view simultaneously.

### Test method

Controllers run as Docker containers on the local development machine (see
[Phase 2 spec §12](../design/spec-climate-platform.md#12-deployment)). A generation script produces a
`docker-compose.override.yml` with N named controller services; `docker compose up -d` brings the
full stack up. To vary N, regenerate and redeploy.

Because the controller HAL is pure simulation, each controller is a lightweight process — running
20–50 controllers concurrently on a developer machine is the expected practical range. An upper bound
will be established empirically during implementation.

### What to observe

| Signal | Why it matters |
|---|---|
| Telemetry ingestion rate | MQTT → DB write throughput under N concurrent publishers |
| Reconciliation latency | Time from a profile/setpoint change to the controller acknowledging it |
| WebSocket fan-out lag | Delay from ingestion to the dashboard receiving a live update |
| DB write throughput | TimescaleDB insert rate under sustained telemetry load |
| API response times | REST endpoint latency under concurrent operator and dashboard load |

### Goals

No hard SLAs are fixed at this stage. The goal for Phase 2 is to **establish baseline behavior** at
representative controller counts (e.g. 5, 20, 50) and identify bottlenecks before they become
production issues. SLAs will be defined once baseline measurements are available.
