#!/usr/bin/env bash
# Fetch an OIDC access token from Keycloak for API scripts / curl once auth is enabled (2b).
#
# Uses the resource-owner password grant against the public `climate-frontend` client (which has
# Direct Access Grants enabled in the realm) — no client secret needed. Prints the raw access token
# to stdout, so it composes:
#
#   TOKEN="$(bash deploy/scripts/get-token.sh)"
#   curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/greenhouses
#
# Override the defaults via env: AUTH_URL, REALM, CLIENT_ID, KC_USER, KC_PASS.
# Defaults to the seeded operator (KC_USER=viewer KC_PASS=viewer for a read-only token).
set -euo pipefail

AUTH="${AUTH_URL:-http://localhost:8080/auth}"
REALM="${REALM:-greenhouse}"
CLIENT="${CLIENT_ID:-climate-frontend}"
USER="${KC_USER:-operator}"
PASS="${KC_PASS:-operator}"

response="$(curl -fsS -X POST "$AUTH/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=$CLIENT" \
  -d "username=$USER" \
  -d "password=$PASS")"

# Extract access_token without requiring jq.
token="$(printf '%s' "$response" | grep -o '"access_token":"[^"]*"' | head -n1 | cut -d'"' -f4)"
if [[ -z "$token" ]]; then
  echo "get-token: no access_token in Keycloak response" >&2
  exit 1
fi
printf '%s' "$token"
