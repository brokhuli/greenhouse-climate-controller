#!/usr/bin/env bash
# Tests for reset-sim-data.sh.  Run:  bash deploy/scripts/reset-sim-data.test.sh
# Hermetic — asserts only against `--print-sql` (no Docker/DB), so it runs anywhere.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET="$SCRIPT_DIR/reset-sim-data.sh"

pass=0
fail=0

# assert_contains DESC HAYSTACK NEEDLE — HAYSTACK includes NEEDLE.
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass=$(( pass + 1 ))
  else
    echo "FAIL: $desc — expected to contain '$needle'" >&2
    echo "      got: $haystack" >&2
    fail=$(( fail + 1 ))
  fi
}

# assert_absent DESC HAYSTACK NEEDLE — HAYSTACK does NOT include NEEDLE.
assert_absent() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass=$(( pass + 1 ))
  else
    echo "FAIL: $desc — expected NOT to contain '$needle'" >&2
    echo "      got: $haystack" >&2
    fail=$(( fail + 1 ))
  fi
}

# assert_rejects DESC ARGS... — the script exits non-zero for these args.
assert_rejects() {
  local desc="$1"; shift
  if bash "$RESET" "$@" >/dev/null 2>&1; then
    echo "FAIL: $desc — expected non-zero exit" >&2
    fail=$(( fail + 1 ))
  else
    pass=$(( pass + 1 ))
  fi
}

# --- Default mode: TRUNCATE targets exactly the three run tables ----------------------------------
default_sql="$(bash "$RESET" --print-sql)"

assert_contains "default truncates sensor_readings" "$default_sql" "sensor_readings"
assert_contains "default truncates actuator_states" "$default_sql" "actuator_states"
assert_contains "default truncates events"          "$default_sql" "events"
assert_contains "default emits a TRUNCATE"          "$default_sql" "TRUNCATE"

# Blast-radius guard: registrations and profiles must never be in the truncate set.
assert_absent "default spares greenhouses"          "$default_sql" "greenhouses"
assert_absent "default spares controller_endpoints" "$default_sql" "controller_endpoints"
assert_absent "default spares crop_profiles"        "$default_sql" "profile"
assert_absent "default spares setpoint_revisions"   "$default_sql" "setpoint"
# Default mode issues no guard query.
assert_absent "default has no guard SELECT"         "$default_sql" "SELECT"

# --- Guarded mode: --if-behind adds a guard SELECT over sensor_readings ---------------------------
guard_ts="2026-07-09T13:00:00.000Z"
guard_sql="$(bash "$RESET" --print-sql --if-behind "$guard_ts")"

assert_contains "guard is a SELECT"                 "$guard_sql" "SELECT"
assert_contains "guard reads sensor_readings"       "$guard_sql" "FROM sensor_readings"
assert_contains "guard compares max(ts)"            "$guard_sql" "max(ts) >="
assert_contains "guard embeds the given timestamp"  "$guard_sql" "$guard_ts"
# Guarded mode still emits the same truncate as the default.
assert_contains "guard still truncates run tables"  "$guard_sql" "TRUNCATE sensor_readings, actuator_states, events;"

# --- Argument handling ----------------------------------------------------------------------------
assert_rejects "unknown flag rejected"     --bogus
assert_rejects "--if-behind needs a value" --if-behind

echo "reset-sim-data: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
