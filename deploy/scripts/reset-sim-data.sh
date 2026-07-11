#!/usr/bin/env bash
# Reset the simulation's run data — the time-series telemetry a running stack has accumulated — while
# leaving greenhouse registrations and crop profiles intact.
#
# Why this exists: the platform keeps telemetry across restarts (the db_data volume survives
# `docker compose down`), keyed by (greenhouse_id, *simulated* timestamp). If a new run's simulated
# clock starts *behind* data already stored (e.g. restarting at 1pm after a run had reached 5pm), the
# detail page anchors its chart window to the newest stored timestamp and clips the live edge, so the
# chart and stat cards freeze (zones/actuators/fleet bypass that merge and keep moving). Clearing the
# prior run's rows makes the live edge the newest point again.
#
# This is the fast alternative to `docker compose down -v`: it truncates only the three run-data tables
# and keeps registrations (greenhouses/controller_endpoints) and profiles, so no re-registration is
# needed.
#
# Usage:
#   reset-sim-data.sh                    truncate now (unconditional clean slate)
#   reset-sim-data.sh --if-behind <TS>   truncate only if stored data sits at/ahead of <TS> (an RFC 3339
#                                        instant, e.g. from resolve-sim-start.sh); otherwise keep the
#                                        history. This is the guard fresh-run.sh uses.
#   reset-sim-data.sh --print-sql [...]  print the SQL it would run and exit — no DB connection (test hook)
#
# Runs against the running `greenhouse-db` container (local trust, same creds as the compose healthcheck).
set -euo pipefail

DB_CONTAINER="greenhouse-db"
PSQL=(docker exec "$DB_CONTAINER" psql -U greenhouse -d greenhouse -v ON_ERROR_STOP=1)

# The three append-only time-series tables (migration 000002_telemetry). Registrations and profiles live
# in other tables and are deliberately left untouched — widening this list would erase the fleet.
RUN_TABLES="sensor_readings, actuator_states, events"
TRUNCATE_SQL="TRUNCATE ${RUN_TABLES};"

usage() {
  sed -n '18,30p' "$0" >&2
  exit "${1:-2}"
}

if_behind=""
print_sql=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --if-behind)
      shift
      [[ $# -gt 0 ]] || { echo "reset-sim-data: --if-behind needs an RFC 3339 timestamp" >&2; exit 2; }
      if_behind="$1"
      ;;
    --print-sql) print_sql=1 ;;
    -h|--help) usage 0 ;;
    *) echo "reset-sim-data: unknown argument '$1'" >&2; usage ;;
  esac
  shift
done

# The guard query: is any stored reading at or ahead of the new start? 't' → the new run would land
# behind stored data (the freeze condition) → truncate; 'f'/empty → keep.
guard_sql=""
if [[ -n "$if_behind" ]]; then
  guard_sql="SELECT (max(ts) >= '${if_behind}'::timestamptz) FROM sensor_readings;"
fi

# Dry run: emit the SQL without touching the database (keeps the unit test hermetic).
if [[ "$print_sql" == 1 ]]; then
  [[ -n "$guard_sql" ]] && printf '%s\n' "$guard_sql"
  printf '%s\n' "$TRUNCATE_SQL"
  exit 0
fi

# Preflight: the stack must be up.
if ! docker exec "$DB_CONTAINER" pg_isready -U greenhouse -d greenhouse >/dev/null 2>&1; then
  echo "reset-sim-data: '$DB_CONTAINER' is not ready — is the stack up?" >&2
  exit 1
fi

truncate_now() { "${PSQL[@]}" -q -c "$TRUNCATE_SQL"; }

if [[ -n "$if_behind" ]]; then
  behind="$("${PSQL[@]}" -tAc "$guard_sql")"
  behind="${behind//[[:space:]]/}"
  if [[ "$behind" == "t" ]]; then
    truncate_now
    echo "reset-sim-data: cleared stale run data (start $if_behind is behind stored data)."
  else
    echo "reset-sim-data: kept history (start $if_behind is ahead of stored data; nothing to clear)."
  fi
else
  truncate_now
  echo "reset-sim-data: cleared run data ($RUN_TABLES)."
fi
