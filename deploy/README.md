# Deploy

Root orchestration for the local stack — **Docker Compose**.

The stack is the full Phase 2 platform — the MQTT broker, TimescaleDB, the Go `api`, Keycloak
(`auth`), and the nginx `proxy` that fronts everything — plus the generated Phase 1 controllers,
running with a single command.

**The `proxy` is the single entry point: everything is reached at `http://localhost:8080`** — it
serves the built React SPA and reverse-proxies `/api` (REST + WebSocket) and `/auth` (Keycloak). The
`api` is no longer exposed directly. The `proxy` service consolidates the spec's `proxy` + `frontend`
into one nginx image. The Phase 1 controllers run as **generated containers** (the HAL is pure
simulation, so there is no hardware dependency). The 2b observability services — **Prometheus** and
**Grafana** — are now live: Prometheus scrapes the `api`'s `/metrics` (platform-health) and every
controller's own `/metrics` (controller-health) over the internal network, and Grafana renders the
dashboards (see [Observability](#observability) below).
Full topology: [08-spec-platform-operations.md](../docs/specs/design/platform/08-spec-platform-operations.md#2-deployment).

**Auth is on (2b).** Reads are open to anyone — the SPA loads the fleet, dashboards, and live
telemetry with no login. The `api` gates every **write** to the **operator** role, validating
the Keycloak-issued token when one is present (an invalid token is rejected; a missing one is
served as an anonymous viewer). Two users are seeded from
[`keycloak/realm.json`](./keycloak/realm.json): **`operator`/`operator`** and **`viewer`/`viewer`**.
Open `http://localhost:8080` to browse read-only; click **Sign in** and authenticate as
`operator` to unlock writes.

## Bring up the stack (platform + N controllers)

```sh
# 1. Set the DB password + Keycloak admin password.
cp deploy/.env.example deploy/.env

# 2. Generate N controller services (per-greenhouse TOML + override + register.sh).
bash deploy/scripts/gen-controllers.sh 2

# 3. Build + start broker, DB, API, Keycloak, proxy, and the N controllers.
docker compose --env-file deploy/.env \
    -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml up -d --build

# 4. Register the greenhouses with the platform (ingest rejects unregistered ids).
#    register.sh fetches an operator token automatically (deploy/scripts/get-token.sh).
bash deploy/controllers/register.sh
```

Open the dashboard at `http://localhost:8080` and sign in as `operator` (writes) or `viewer`
(read-only). To exercise the API with `curl`, grab a token first — reads work with any user, writes
need `operator`:

```sh
TOKEN="$(bash deploy/scripts/get-token.sh)"                            # operator by default
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/greenhouses  # fleet, both online
curl -H "Authorization: Bearer $TOKEN" \
     "localhost:8080/api/greenhouses/gh-a/analytics?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z&interval=5m"
curl -X PATCH localhost:8080/api/greenhouses/gh-a/setpoints \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"temperature_day_c":23}'   # operator-only; relayed to the controller
# A viewer token (KC_USER=viewer KC_PASS=viewer bash deploy/scripts/get-token.sh) gets 403 on writes.
# WebSocket live frames pass the token as a query param:
#   wscat -c "ws://localhost:8080/api/stream?access_token=$TOKEN"
```

`gen-controllers.sh N` is the lever for **performance testing** under different greenhouse counts
(operations §2). Generated files (`docker-compose.override.yml`, `controllers/`) are git-ignored.

**Shared simulated start.** `gen-controllers.sh` picks one `start_ts` — by default **today (UTC) at a
random whole hour** — and stamps the same value into every controller's TOML, so the whole fleet's
first telemetry timestamp and initial time-of-day match; each controller then drifts as it advances
on its own `time_scale`. Pin a run (e.g. to reproduce a demo) by exporting `SIM_START_TS` before
generating — it accepts a friendly time or a full RFC 3339 timestamp:

```sh
SIM_START_TS=now  bash deploy/scripts/gen-controllers.sh 2   # start at the current (local) time
SIM_START_TS=6pm  bash deploy/scripts/gen-controllers.sh 2   # greenhouse clock reads 6pm (also 11am, 18:00)
SIM_START_TS=2026-07-09T14:00:00Z bash deploy/scripts/gen-controllers.sh 2   # exact instant
# (omitted → today at a random whole hour, as before)
```

Hour inputs are literal — `6pm` makes the greenhouse clock read 6pm regardless of your timezone —
while `now` uses your local wall time. The chosen value is printed in the script's summary.

**Fresh run vs. continue.** The telemetry store survives restarts (`docker compose down` keeps the
`db_data` volume — 30-day retention, no reset), keyed by *simulated* timestamp. So if you start a new run
whose clock is **behind** data already stored — e.g. restarting at 1pm after a run had reached 5pm — the
new live readings land in the chart's past: the detail page anchors its window to the newest *stored*
timestamp and clips the live edge, freezing the climate chart and stat cards (the fleet, zones, and
actuators keep updating, since they don't window on time). Use the one-command wrapper for a clean run —
it regenerates, rebuilds, brings the stack up, clears prior-run telemetry **only if the new start is
behind it**, and registers the fleet:

```sh
SIM_START_TS=1pm bash deploy/scripts/fresh-run.sh 4   # clean run at 1pm (guarded reset if needed)
```

To **continue** the current run, just bring the stack up as usual (no reset). To clear run data by hand at
any time — the fast alternative to wiping the volume, since it keeps registrations and profiles — run
`bash deploy/scripts/reset-sim-data.sh` (add `--if-behind <start>` for the guarded form). Wiping the whole
`db_data` volume (`docker compose … down -v`) remains the full-reset fallback.

## Service-auth hardening (RFC-011, dormant by default)

Beyond the human viewer/operator auth above, two internal **service** write boundaries can be hardened
for a multi-host posture. Both are **off by default** — the single-host stack behaves as documented above.

- **Optimizer → `POST /setpoints`.** `PLATFORM_SERVICE_AUTH_MODE` (in the `api` env, default
  `trusted_network`) gates the optimizer's setpoint write path. Set it to `oidc` and `POST
  /api/greenhouses/{id}/setpoints` requires a Keycloak **client-credentials** token carrying the narrow
  `setpoints:write` role (or an operator token); the dormant `optimizer` client lives in
  [`keycloak/realm.json`](./keycloak/realm.json). Acquire one with the client secret:

  ```sh
  curl -s -X POST localhost:8080/auth/realms/greenhouse/protocol/openid-connect/token \
       -d grant_type=client_credentials -d client_id=optimizer -d client_secret=dev-optimizer-secret
  # → present the access_token as `Authorization: Bearer …` on POST /setpoints (202 on success).
  ```
  Rotate `dev-optimizer-secret` for any real deployment. In the default `trusted_network` mode the call
  is accepted untokened, exactly as today.

- **Platform → controller REST.** Each controller supports an optional `[api].auth_token`; when set it
  requires a matching `Bearer` on its write endpoints (reads stay open). Run
  `CONTROLLER_AUTH_TOKENS=1 bash deploy/scripts/gen-controllers.sh N` to mint one per controller — the
  generator writes it into each controller's TOML and registers the greenhouse with the matching
  `bearer_token`, so the platform presents it on every downward call. Unset (default) → controllers stay
  unauthenticated.

## Observability

Prometheus and Grafana ship with the stack (operations §1). Prometheus scrapes two sources over the
internal network — **nothing extra is exposed through the proxy**:

- **`api:8080/metrics`** — platform-health: ingestion rate, API latency/errors, reconciliation
  actions, per-controller connectivity, and datastore/background-job health (`platform_*`).
- **each `gh-*:8080/metrics`** — controller-health: tick cadence/compute, MQTT publish + connection,
  faults/mode, config applies (`controller_*`, labelled by `greenhouse_id`). The controllers are a
  **dynamic** fleet, so `gen-controllers.sh` also emits a Prometheus file-SD target list at
  `prometheus/targets/controllers.json` (git-ignored); Prometheus hot-reloads it, so scaling N needs
  no config change.
- **`cadvisor:8080/metrics`** — container-resources: per-container CPU, memory, network, and uptime
  (`container_*`) for *every* service in the stack, not just the app. This is infra-level visibility
  the `platform_*`/`controller_*` app metrics can't give ("is a container starving or leaking?"). The
  `cadvisor` service reads Docker/cgroup stats; its own UI is on the host at
  [http://localhost:8081](http://localhost:8081) for debugging.

```sh
open http://localhost:3000        # Grafana (admin/admin) → "Platform Health" + "Controller Fleet" + "Container Resources"
open http://localhost:9090/targets # Prometheus — platform-api + controllers + cadvisor should be UP
```

Grafana's Prometheus datasource and all three dashboards are auto-provisioned from `deploy/grafana/`
(dropping a JSON into `grafana/dashboards/` is enough — the provider globs the directory); the admin
login is `GRAFANA_ADMIN` / `GRAFANA_ADMIN_PASSWORD` (default `admin`/`admin`, in `deploy/.env`).

Platform Health and Controller Fleet read top-down as **operational health boards**, not a wall of
line charts: a "right now" row of **stat** panels (API p95 / 5xx / ingest drops; fleet interlock /
degraded / fault counts) with green→amber→red thresholds, then **state timelines** for discrete
states (platform connectivity, controller mode, MQTT up/down), then **bar gauges** ranking
greenhouses by tick p95 / CPU / RSS, a **table** of background-job health, **heatmaps** for
latency/tick distributions, and **bar charts** for categorical counts (reconciliation actions, faults
by type). Time series is kept only for genuine rates/trends (ingestion, tick rate, MQTT publish vs
dropped, and per-greenhouse CPU / memory trends — so resource use has both a current bar gauge and a
trend line). Controller Fleet has a `$greenhouse` template variable to filter the fleet down to one
or more controllers. **Container Resources** follows the same layout for the cAdvisor `container_*`
metrics — a "right now" row (containers running / total CPU / total memory), per-container CPU and
memory bar gauges, an uptime table, and CPU / memory / network trend lines — scoped to the stack via
`{name=~"greenhouse-.+"}`.

## Inject demo faults

To populate the dashboard's Recent Activity feed (and trip the fleet "degraded" state) without
waiting for the simulation to fault on its own, publish a demo set of faults to the broker:

```sh
bash deploy/scripts/inject-faults.sh            # demo set on gh-a
bash deploy/scripts/inject-faults.sh gh-a gh-b  # demo set on each given greenhouse
```

It publishes to `gh/{id}/fault` through the broker container (no host MQTT client needed), spanning
both event kinds (fault/interlock) and all three severities. The target greenhouse must already be
registered. Note the "degraded" state is transient — a healthy controller's next `gh/{id}/state`
clears it — but the events themselves persist.

The standalone Phase 1 controller can still run as a native binary against the broker at
`localhost:1883`; broker config is [`mosquitto/config/mosquitto.conf`](./mosquitto/config/mosquitto.conf)
(anonymous auth + persistence per RFC-001).
