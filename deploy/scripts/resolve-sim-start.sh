#!/usr/bin/env bash
# Resolve the fleet's simulated-clock start instant (simulation.start_ts) from a friendly input.
#
# Called by gen-controllers.sh with the raw SIM_START_TS value as $1 (may be empty). Echoes an
# RFC 3339 UTC timestamp (YYYY-MM-DDThh:mm:ss.000Z) that every controller is stamped with, or prints
# a usage error and exits non-zero on an input it can't parse.
#
# Accepted forms:
#   (empty)                 today (UTC) at a random whole hour — the default when SIM_START_TS is unset
#   now | current           the current LOCAL wall time, so the greenhouse clock matches the one you see
#   6pm 11am 12am 6:30pm     a 12-hour time today
#   18:00 06:30              a 24-hour time today
#   2026-07-09T14:00:00Z     a full RFC 3339 timestamp, passed through unchanged
#
# Hours are literal: "6pm" makes the greenhouse clock read 6pm regardless of your timezone. The stamp
# is always suffixed Z because the simulator treats start_ts as its wall clock; platform liveness is
# keyed off real message-arrival time, not this value, so the offset is harmless.
set -euo pipefail

raw="${1:-}"

usage() {
  cat >&2 <<'EOF'
resolve-sim-start.sh: could not parse SIM_START_TS.
Accepted forms:
  (empty)                 random whole hour today (the default)
  now | current           the current local wall time
  6pm 11am 12am 6:30pm    a 12-hour time today
  18:00 06:30             a 24-hour time today
  2026-07-09T14:00:00Z    a full RFC 3339 timestamp
EOF
  exit 1
}

# Emit today's (local) date at the given hour:minute, stamped Z.
stamp_today() {
  local hour="$1" minute="$2"
  printf '%sT%02d:%02d:00.000Z\n' "$(date +%Y-%m-%d)" "$hour" "$minute"
}

# Lowercase so keywords and am/pm match case-insensitively.
lower="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"

if [[ -z "$lower" ]]; then
  # Unchanged default: today (UTC) at a random whole hour.
  printf '%sT%02d:00:00.000Z\n' "$(date -u +%Y-%m-%d)" "$(( RANDOM % 24 ))"
  exit 0
fi

case "$lower" in
  now|current)
    # Current local wall time, stamped Z so the greenhouse clock reads the time you see.
    printf '%s.000Z\n' "$(date +%Y-%m-%dT%H:%M:%S)"
    ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]t*)
    # Already a full RFC 3339 timestamp — echo the original (the controller validates it strictly).
    printf '%s\n' "$raw"
    ;;
  *am|*pm)
    # 12-hour: <hour>[:<minute>](am|pm).
    meridiem="${lower: -2}"
    clock="${lower%??}"
    minute=0
    if [[ "$clock" == *:* ]]; then
      minute="${clock#*:}"
      clock="${clock%%:*}"
    fi
    [[ "$clock" =~ ^[0-9]{1,2}$ && "$minute" =~ ^[0-9]{1,2}$ ]] || usage
    (( clock >= 1 && clock <= 12 && 10#$minute <= 59 )) || usage
    hour="$clock"
    if [[ "$meridiem" == "am" ]]; then
      if (( hour == 12 )); then hour=0; fi
    else
      if (( hour != 12 )); then hour=$(( hour + 12 )); fi
    fi
    stamp_today "$hour" "$(( 10#$minute ))"
    ;;
  *:*)
    # 24-hour: HH:MM.
    hour="${lower%%:*}"
    minute="${lower#*:}"
    [[ "$hour" =~ ^[0-9]{1,2}$ && "$minute" =~ ^[0-9]{1,2}$ ]] || usage
    (( 10#$hour <= 23 && 10#$minute <= 59 )) || usage
    stamp_today "$(( 10#$hour ))" "$(( 10#$minute ))"
    ;;
  *)
    usage
    ;;
esac
