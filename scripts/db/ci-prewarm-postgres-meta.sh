#!/usr/bin/env bash
# CI-only: pre-pull the postgres-meta image `db:gen-types` needs, concurrently
# with db:start + db:reset.
#
# `supabase gen types --local` shells out to a one-shot postgres-meta container
# that `supabase start` never creates, so its ~99 MB image is pulled COLD at the
# very tail of the bootstrap — pure critical path, after migrations and seed are
# already done. Starting the pull up front overlaps it with the ~100s of
# start/migrate/seed that has to happen anyway.
#
# The tag is read from `supabase services` (the pinned CLI's own image table)
# rather than hardcoded, so a CLI bump can never leave us prewarming a stale tag
# and silently paying the cold pull again. Best-effort by design: any failure
# just means gen-types pulls the image itself, exactly as it does today.
#
# Usage: bash scripts/db/ci-prewarm-postgres-meta.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 0

CLI="./node_modules/.bin/supabase"
if [ ! -x "$CLI" ]; then
	echo "prewarm: supabase CLI not found at $CLI — skipping"
	exit 0
fi

# Row shape: `  supabase/postgres-meta | v0.96.6 | - `
TAG="$("$CLI" services 2>/dev/null |
	awk -F'|' '$1 ~ /supabase\/postgres-meta/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"

if [ -z "${TAG:-}" ]; then
	echo "prewarm: could not resolve the postgres-meta tag from 'supabase services' — skipping"
	exit 0
fi

IMAGE="public.ecr.aws/supabase/postgres-meta:${TAG}"
echo "prewarm: pulling ${IMAGE}"
if docker pull --quiet "$IMAGE"; then
	echo "prewarm: ${IMAGE} ready"
else
	echo "prewarm: pull failed (non-fatal) — db:gen-types will pull it"
fi

exit 0
