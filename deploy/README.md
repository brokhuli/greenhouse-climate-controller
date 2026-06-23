# Deploy

Root orchestration for the local stack — **Docker Compose**.

The eventual stack is the full Phase 2 platform (API, database, reverse proxy, frontend, auth,
observability) plus the MQTT broker, running with a single command — and the cross-phase
end-to-end harness used for integration testing.

**Today (Phase 2a backend) the live services are the Mosquitto broker, TimescaleDB, and the Go
platform `api`.** The React SPA and its nginx `proxy` are a later slice, so the `api` is exposed
on host port `8080` directly. The Phase 1 controllers run as **generated containers** (the HAL is
pure simulation, so there is no hardware dependency); the 2b services (auth, Prometheus, Grafana)
remain commented placeholders in [`docker-compose.yml`](./docker-compose.yml). Full topology:
[08-spec-platform-operations.md](../docs/specs/design/platform/08-spec-platform-operations.md#2-deployment).

## Bring up the stack (platform + N controllers)

```sh
# 1. Set the database password.
cp deploy/.env.example deploy/.env

# 2. Generate N controller services (per-greenhouse TOML + override + register.sh).
bash deploy/scripts/gen-controllers.sh 2

# 3. Build + start broker, DB, API, and the N controllers.
docker compose --env-file deploy/.env \
    -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml up -d --build

# 4. Register the greenhouses with the platform (ingest rejects unregistered ids).
bash deploy/controllers/register.sh
```

Then exercise the API on `http://localhost:8080`:

```sh
curl localhost:8080/api/greenhouses                                   # fleet, both online
curl "localhost:8080/api/greenhouses/gh-a/telemetry?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z"
curl "localhost:8080/api/greenhouses/gh-a/analytics?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z&interval=5m"
curl -X PATCH localhost:8080/api/greenhouses/gh-a/setpoints \
     -H 'Content-Type: application/json' -d '{"temperature_day_c":23}'   # relayed to the controller
curl -X PATCH localhost:8080/api/sim/time-scale \
     -H 'Content-Type: application/json' -d '{"scale":4}'                # fleet fast-forward
# WebSocket live frames (telemetry/status/event):
#   wscat -c ws://localhost:8080/api/stream
```

`gen-controllers.sh N` is the lever for **performance testing** under different greenhouse counts
(operations §2). Generated files (`docker-compose.override.yml`, `controllers/`) are git-ignored.

The standalone Phase 1 controller can still run as a native binary against the broker at
`localhost:1883`; broker config is [`mosquitto/config/mosquitto.conf`](./mosquitto/config/mosquitto.conf)
(anonymous auth + persistence per RFC-001).
