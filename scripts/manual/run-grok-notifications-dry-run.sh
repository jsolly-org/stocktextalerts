#!/usr/bin/env bash
# Manually trigger a Grok "notification" dry run (no sends).
# Loads .env.local from project root if present.
#
# Usage:
#   ./scripts/manual/run-grok-notifications-dry-run.sh --tickers AAPL,MSFT [--kinds news,rumors] [--timezone America/New_York] [--date 2026-02-08] [--market-open true|false]
#
# Examples:
#   ./scripts/manual/run-grok-notifications-dry-run.sh --tickers AAPL,MSFT
#   ./scripts/manual/run-grok-notifications-dry-run.sh --tickers NVDA --kinds news
#
# Notes:
#   - Requires XAI_API_KEY (in .env.local or env).
#   - Prints a preview only; does NOT send SMS/email.
#   - ALLOW_REMOTE=1 can override local-only checks (not recommended).

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

if [ -f .env.local ]; then
  set -a
  # shellcheck source=/dev/null
  source .env.local
  set +a
fi

if [ "${ALLOW_REMOTE:-}" != "1" ]; then
  if [ -n "${SUPABASE_URL:-}" ] && ! is_local_url "$SUPABASE_URL"; then
    echo "Refusing to run with non-local SUPABASE_URL: $SUPABASE_URL" >&2
    echo "Point this at local Supabase (usually http://127.0.0.1:54321) or export ALLOW_REMOTE=1." >&2
    exit 1
  fi
  if [ -n "${DATABASE_URL:-}" ] && ! is_local_url "$DATABASE_URL"; then
    echo "Refusing to run with non-local DATABASE_URL: $DATABASE_URL" >&2
    echo "Point this at local Postgres (supabase start) or export ALLOW_REMOTE=1." >&2
    exit 1
  fi
fi

node ./node_modules/.bin/tsx scripts/manual/grok-notifications-dry-run.ts "$@"

