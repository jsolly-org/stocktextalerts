#!/usr/bin/env bash
# Manually trigger the scheduled notifications cron job (POST /api/notifications/scheduled).
# Requires CRON_SECRET. Loads .env.local from project root if present.
# Usage: ./scripts/run-scheduled-cron.sh
#   BASE_URL=http://localhost:4321  (default)
#   CRON_SECRET=...                 (from env or .env.local)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

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
URL="${BASE_URL}/api/notifications/scheduled"

echo "POST $URL"
curl -s -X POST "$URL" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -w "\nHTTP %{http_code}\n" \
  -o /dev/stdout
