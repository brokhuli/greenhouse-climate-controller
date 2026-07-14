#!/usr/bin/env bash
# Inject a demo set of controller faults into the running stack, so the dashboard's
# Recent Activity feed (and the fleet "degraded" state) has something to show without
# waiting for the simulation to trip an interlock on its own.
#
# Faults are published to gh/{id}/fault on the Mosquitto broker exactly as a controller
# would; the platform ingests them into activity-feed events (fault/interlock, graded
# info/warning/critical) and fans them out live over the WebSocket. The payloads honor
# the contracts/controller-platform-telemetry-mqtt fault-event schema (real fault_type enum + required response).
#
# The publish goes through `docker exec <broker> mosquitto_pub`, so no host MQTT client
# is needed. Ingest rejects faults for unregistered greenhouses, so the target must
# already be registered (deploy/controllers/register.sh).
#
# Usage:
#   bash deploy/scripts/inject-faults.sh                 # demo set on gh-a
#   bash deploy/scripts/inject-faults.sh gh-a gh-b       # demo set on each given greenhouse
#
# Env:
#   MQTT_CONTAINER   broker container name (default: greenhouse-mqtt)
set -euo pipefail

MQTT_CONTAINER="${MQTT_CONTAINER:-greenhouse-mqtt}"

greenhouses=("$@")
(( ${#greenhouses[@]} )) || greenhouses=(gh-a)

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }
if ! docker exec "$MQTT_CONTAINER" true 2>/dev/null; then
  echo "broker container '$MQTT_CONTAINER' is not running (set MQTT_CONTAINER to override)" >&2
  exit 1
fi

# ts_at N -> ISO-8601 UTC, N seconds from now. Distinct stamps keep the feed ordered;
# falls back to now where `date -d` is unavailable (e.g. BSD/macOS date).
ts_at() {
  date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

# publish_fault <gh> <component> <fault_type> <severity> <response> <message> <ts>
publish_fault() {
  local gh="$1" component="$2" fault_type="$3" severity="$4" response="$5" message="$6" ts="$7"
  printf '{"schema_version":1,"greenhouse_id":"%s","ts":"%s","component":"%s","fault_type":"%s","severity":"%s","response":"%s","message":"%s"}' \
    "$gh" "$ts" "$component" "$fault_type" "$severity" "$response" "$message" \
    | docker exec -i "$MQTT_CONTAINER" mosquitto_pub -t "gh/$gh/fault" -s
  printf '  %-6s %s/%s\n' "$gh" "$fault_type" "$severity"
}

# A spread across both kinds (interlock vs fault) and all three dashboard severities.
inject_set() {
  local gh="$1"
  publish_fault "$gh" temperature      critical_temperature   alarm   "opened vents, locked out heater" "House temperature exceeded the critical limit"   "$(ts_at 0)"
  publish_fault "$gh" co2              co2_ceiling            alarm   "disabled injector, opened vents" "CO2 exceeded the safety ceiling"                  "$(ts_at 1)"
  publish_fault "$gh" irrigation_valve irrigation_no_response warning "disabled zone irrigation"        "Irrigation valve commanded open but no flow detected" "$(ts_at 2)"
  publish_fault "$gh" humidity         out_of_range           warning "held last-known value"           "Humidity reading outside the plausible range"     "$(ts_at 3)"
}

echo "Injecting faults via $MQTT_CONTAINER:"
for gh in "${greenhouses[@]}"; do
  inject_set "$gh"
done
echo "Done. View them in the dashboard's Recent Activity, or: curl localhost:8080/api/events"
