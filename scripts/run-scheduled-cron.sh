#!/usr/bin/env bash
# Manually trigger the scheduled notifications cron job (POST /api/schedule).
# Requires CRON_SECRET. Loads .env.local from project root if present.
# Usage: ./scripts/run-scheduled-cron.sh [--force]
#   --force    Process all users with daily digest enabled (ignore next_send_at <= now).
#   BASE_URL=http://localhost:4321  (default)
#   CRON_SECRET=...                 (from env or .env.local)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

FORCE=""
for arg in "$@"; do
  if [ "$arg" = "--force" ] || [ "$arg" = "-f" ]; then
    FORCE='{"force":true}'
    break
  fi
done

if [ -f .env.local ]; then
  set -a
  # shellcheck source=/dev/null
  source .env.local
  set +a
fi

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET is not set. Set it in .env.local or pass it when running this script." >&2
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:4321}"
URL="${BASE_URL}/api/schedule"

if [ -n "$FORCE" ]; then
  echo "POST $URL (force send)"
  curl -s -X POST "$URL" \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json" \
    -d "$FORCE" \
    -w "\nHTTP %{http_code}\n" \
    -o /dev/stdout
else
  echo "POST $URL"
  curl -s -X POST "$URL" \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json" \
    -w "\nHTTP %{http_code}\n" \
    -o /dev/stdout
fi
