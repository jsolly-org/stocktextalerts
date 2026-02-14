#!/usr/bin/env bash
# Manually trigger the scheduled notifications cron job (POST /api/schedule).
# Requires CRON_SECRET. Loads .env.local from project root if present.
# Usage: ./scripts/one-off-testing/run-scheduled-cron.sh [--force]
#   --force    Process all users with scheduled updates enabled (ignore next_send_at <= now).
#   BASE_URL=http://localhost:4321  (default)
#   CRON_SECRET=...                 (from env or .env.local)
#   ALLOW_REMOTE=1                  (override safety checks; use with care)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

is_local_url() {
  node --input-type=module -e '
    const input = process.argv[1] ?? "";
    const locals = new Set(["localhost","127.0.0.1","::1","0.0.0.0","host.docker.internal"]);
    try {
      const host = new URL(input).hostname.toLowerCase();
      process.exit(locals.has(host) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1"
}

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

if [ "${ALLOW_REMOTE:-}" != "1" ]; then
  BASE_URL="${BASE_URL:-http://localhost:4321}"

  if ! is_local_url "$BASE_URL"; then
    echo "Refusing to run against non-local BASE_URL: $BASE_URL" >&2
    echo "Set BASE_URL to localhost (or export ALLOW_REMOTE=1 to override)." >&2
    exit 1
  fi

  if [ -z "${SUPABASE_URL:-}" ]; then
    echo "SUPABASE_URL is not set; cannot confirm local Supabase. Refusing to run." >&2
    echo "Set SUPABASE_URL to your local Supabase URL (usually http://127.0.0.1:54321)." >&2
    echo "Or export ALLOW_REMOTE=1 to override." >&2
    exit 1
  fi
  if ! is_local_url "$SUPABASE_URL"; then
    echo "Refusing to run with non-local SUPABASE_URL: $SUPABASE_URL" >&2
    echo "Point this at local Supabase (usually http://127.0.0.1:54321) or export ALLOW_REMOTE=1." >&2
    exit 1
  fi

  if [ -n "${DATABASE_URL:-}" ] && ! is_local_url "$DATABASE_URL"; then
    echo "Refusing to run with non-local DATABASE_URL: $DATABASE_URL" >&2
    echo "Point this at local Postgres (supabase start) or export ALLOW_REMOTE=1." >&2
    exit 1
  fi
else
  BASE_URL="${BASE_URL:-http://localhost:4321}"
fi

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET is not set. Set it in .env.local or pass it when running this script." >&2
  exit 1
fi

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
    -w "\nHTTP %{http_code}\n" \
    -o /dev/stdout
fi

