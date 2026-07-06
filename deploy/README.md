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

```sh
open http://localhost:3000        # Grafana (admin/admin) → "Platform Health" + "Controller Fleet"
open http://localhost:9090/targets # Prometheus — platform-api + controllers should be UP
```

Grafana's Prometheus datasource and both dashboards are auto-provisioned from `deploy/grafana/`; the
admin login is `GRAFANA_ADMIN` / `GRAFANA_ADMIN_PASSWORD` (default `admin`/`admin`, in `deploy/.env`).

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
