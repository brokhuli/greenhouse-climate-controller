#!/usr/bin/env bash
# One-command clean bring-up of the local stack for a *fresh simulation run*.
#
# Regenerates N controllers at a chosen simulated start, (re)builds and starts the whole stack, and —
# only when the new start would land behind data already stored (which otherwise freezes the detail-page
# charts; see reset-sim-data.sh) — clears the prior run's telemetry. Registrations and profiles are
# preserved. To *continue* the current run instead, just run `docker compose ... up -d` as usual.
#
# Usage:  bash deploy/scripts/fresh-run.sh [N]        (default N=2)
# Env:    SIM_START_TS              friendly time or RFC 3339 start (see resolve-sim-start.sh);
#                                   unset → today at a random whole hour
#         CONTROLLER_AUTH_TOKENS=1  mint a per-controller bearer token (passed to gen-controllers.sh)
set -euo pipefail

N="${1:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE=(docker compose --env-file "$DEPLOY_DIR/.env"
         -f "$DEPLOY_DIR/docker-compose.yml"
         -f "$DEPLOY_DIR/docker-compose.override.yml")
API="http://127.0.0.1:8080"   # 127.0.0.1, not localhost: dodges the Windows IPv6 handshake stall.

# Resolve the simulated start ONCE, so the guard comparison and the value stamped into the controllers
# agree — the default (unset) resolves to a *random* hour, so resolving twice would diverge. A full
# RFC 3339 value passes through resolve-sim-start.sh unchanged, so gen-controllers re-resolving it below
# is a no-op.
resolved_start="$(bash "$SCRIPT_DIR/resolve-sim-start.sh" "${SIM_START_TS:-}")"
export SIM_START_TS="$resolved_start"
echo "==> fresh run: simulated start = $resolved_start ; controllers = $N"

# 1. Regenerate controller configs (+ override, register.sh, Prometheus targets) at the resolved start.
#    Done before `down` so the override the compose commands reference always exists (first run too).
bash "$SCRIPT_DIR/gen-controllers.sh" "$N"

# 2. Tear down the current run (keeps named volumes; forces controllers to reload the regenerated TOML —
#    a bind-mount content change alone does not make `up` recreate them).
"${COMPOSE[@]}" down

# 3. Build + start everything; --wait blocks until healthchecked services (incl. db) are healthy.
"${COMPOSE[@]}" up -d --build --wait

# 4. Wait for the API (behind the proxy) to answer before the guarded reset / registration.
echo "==> waiting for the API at $API ..."
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$API/api/greenhouses" >/dev/null 2>&1; then break; fi
  sleep 1
done

# 5. Guarded reset: clear prior-run telemetry only if it sits at/ahead of the new start (rewind → freeze);
#    a forward/clean start keeps its history.
bash "$SCRIPT_DIR/reset-sim-data.sh" --if-behind "$resolved_start"

# 6. Register the greenhouses (idempotent; API_URL/AUTH_URL target 127.0.0.1 to dodge the IPv6 stall).
API_URL="$API" AUTH_URL="$API/auth" bash "$DEPLOY_DIR/controllers/register.sh"

echo "==> done — open $API ; detail charts track the live edge (start $resolved_start)."
