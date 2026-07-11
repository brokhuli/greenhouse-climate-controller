#!/usr/bin/env bash
# Tests for resolve-sim-start.sh.  Run:  bash deploy/scripts/resolve-sim-start.test.sh
# No dependencies beyond bash + date. The date portion of each result is ignored so the assertions
# stay deterministic across days and timezones.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVE="$SCRIPT_DIR/resolve-sim-start.sh"

pass=0
fail=0

# assert_suffix INPUT WANT — the resolver's output ends with WANT.
assert_suffix() {
  local input="$1" want="$2" got
  got="$(bash "$RESOLVE" "$input")"
  if [[ "$got" == *"$want" ]]; then
    pass=$(( pass + 1 ))
  else
    echo "FAIL: resolve '$input' -> '$got', expected to end with '$want'" >&2
    fail=$(( fail + 1 ))
  fi
}

# assert_matches INPUT REGEX — the resolver's output matches REGEX.
assert_matches() {
  local input="$1" regex="$2" got
  got="$(bash "$RESOLVE" "$input")"
  if [[ "$got" =~ $regex ]]; then
    pass=$(( pass + 1 ))
  else
    echo "FAIL: resolve '$input' -> '$got', expected to match /$regex/" >&2
    fail=$(( fail + 1 ))
  fi
}

# assert_exact INPUT WANT — the resolver echoes WANT verbatim.
assert_exact() {
  local input="$1" want="$2" got
  got="$(bash "$RESOLVE" "$input")"
  if [[ "$got" == "$want" ]]; then
    pass=$(( pass + 1 ))
  else
    echo "FAIL: resolve '$input' -> '$got', expected '$want'" >&2
    fail=$(( fail + 1 ))
  fi
}

# assert_rejects INPUT — the resolver exits non-zero.
assert_rejects() {
  local input="$1"
  if bash "$RESOLVE" "$input" >/dev/null 2>&1; then
    echo "FAIL: resolve '$input' should have been rejected but succeeded" >&2
    fail=$(( fail + 1 ))
  else
    pass=$(( pass + 1 ))
  fi
}

full='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$'

# 12-hour
assert_suffix "6pm"    "T18:00:00.000Z"
assert_suffix "11am"   "T11:00:00.000Z"
assert_suffix "12am"   "T00:00:00.000Z"
assert_suffix "12pm"   "T12:00:00.000Z"
assert_suffix "6:30pm" "T18:30:00.000Z"
assert_suffix "9AM"    "T09:00:00.000Z"   # case-insensitive

# 24-hour
assert_suffix "18:00"  "T18:00:00.000Z"
assert_suffix "06:30"  "T06:30:00.000Z"
assert_suffix "0:00"   "T00:00:00.000Z"

# now / current — current local wall time, full precision
assert_matches "now"     "$full"
assert_matches "current" "$full"
assert_matches "NOW"     "$full"

# empty → random whole hour today
assert_matches "" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00\.000Z$'

# RFC 3339 passthrough (echoed unchanged, original case preserved)
assert_exact "2026-07-09T14:00:00Z"     "2026-07-09T14:00:00Z"
assert_exact "2026-07-09T14:00:00.000Z" "2026-07-09T14:00:00.000Z"

# garbage → rejected
assert_rejects "teatime"
assert_rejects "25:00"
assert_rejects "13pm"
assert_rejects "0am"
assert_rejects "pm"

echo "resolve-sim-start: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
