#!/usr/bin/env bash
# CI-only: start Supabase, write env, reset DB — one backgroundable unit.
#
# Used by .github/workflows/ci.yml so image pulls + migrate/seed overlap static
# checks / sam build / Playwright install. Local DX keeps db:start and db:reset
# separate (start without wipe; reset without restart).
#
# Requires TRANSIENT_REGEX + DEFAULT_PASSWORD in the environment (shared with
# ci-db-retry.sh / the workflow). Expects .env.local already prepared by the
# workflow (stubs stay in ci.yml so gitleaks doesn't flag CI placeholders here).
# Writes:
#   /tmp/ci-bootstrap.rc     — exit status for the wait step
#   /tmp/ci-bootstrap.env    — KEY=VALUE lines for GITHUB_ENV
#   .env.local               — Supabase keys appended/updated after start
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RC_FILE="${CI_BOOTSTRAP_RC_FILE:-/tmp/ci-bootstrap.rc}"
ENV_FILE="${CI_BOOTSTRAP_ENV_FILE:-/tmp/ci-bootstrap.env}"
LOG_DIR="${CI_BOOTSTRAP_LOG_DIR:-/tmp}"

write_rc() {
	echo "$1" >"$RC_FILE"
}

fail() {
	write_rc "${1:-1}"
	exit "${1:-1}"
}

if [ -z "${TRANSIENT_REGEX:-}" ]; then
	echo "::error::TRANSIENT_REGEX is unset — refusing to bootstrap without a retry classifier." >&2
	fail 2
fi

if [ -z "${DEFAULT_PASSWORD:-}" ]; then
	echo "::error::DEFAULT_PASSWORD is unset." >&2
	fail 2
fi

if [ ! -f .env.local ]; then
	echo "::error::.env.local missing — workflow must prepare stubs before launching bootstrap." >&2
	fail 2
fi

# --- prewarm postgres-meta (background) --------------------------------------
# db:gen-types (run by db:reset below) needs an image `supabase start` never
# pulls, so it lands cold on the critical path after migrate/seed. Overlap that
# pull with the rest of the bootstrap. Skipped when this job opted out of
# gen-types entirely. See scripts/db/ci-prewarm-postgres-meta.sh.
PREWARM_PID=""
if [ "${DB_RESET_SKIP_GEN_TYPES:-0}" != "1" ]; then
	bash scripts/db/ci-prewarm-postgres-meta.sh >"$LOG_DIR/prewarm-postgres-meta.log" 2>&1 &
	PREWARM_PID=$!
fi

# --- start (registry-throttle retry) -----------------------------------------
# Phase timings: the wait step only tails this log, so `supabase start`'s image-pull output is
# usually scrolled off. Without these markers there is no way to tell from a finished run whether
# the bootstrap went to registry pulls (fix: container caching / fewer containers) or to
# migrate+seed. Printed again as a one-line summary at the end, which also names the second
# phase `seed-only` or `full-reset`, so a silent fallback to the slow path is visible in the tail.
START_BEGIN=$SECONDS
bash scripts/db/ci-db-retry.sh db:start "$LOG_DIR/db-start.log" || fail $?
START_SECONDS=$((SECONDS - START_BEGIN))
echo "ci-bootstrap: db:start took ${START_SECONDS}s"

# --- load supabase status into .env.local + env file for GITHUB_ENV ----------
./node_modules/.bin/supabase status -o json >"$LOG_DIR/sb-status.json"
DB_VARS=$(jq -r '
	"SUPABASE_URL=\(.API_URL // "")",
	"SUPABASE_PUBLISHABLE_KEY=\(.ANON_KEY // "")",
	"SUPABASE_SECRET_KEY=\(.SERVICE_ROLE_KEY // "")",
	"DATABASE_URL=\(.DB_URL // "")"
' "$LOG_DIR/sb-status.json")

: >"$ENV_FILE"
INVALID_DB_VARS=0
declare -A DB_VARS_SEEN_KEYS=()
while IFS= read -r LINE; do
	[[ -z "$LINE" ]] && continue
	if [[ "$LINE" != *"="* ]]; then
		echo "Error: Supabase env var line is malformed: $LINE" >&2
		INVALID_DB_VARS=1
		continue
	fi
	KEY="${LINE%%=*}"
	VALUE="${LINE#*=}"
	DB_VARS_SEEN_KEYS["$KEY"]=1
	VALUE_TRIMMED="${VALUE//[[:space:]]/}"
	if [[ -z "$VALUE_TRIMMED" || "$VALUE" == "null" ]]; then
		echo "Error: Supabase status did not provide a valid value for $KEY." >&2
		INVALID_DB_VARS=1
	fi
done <<<"$DB_VARS"

for KEY in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY DATABASE_URL; do
	if [[ -z "${DB_VARS_SEEN_KEYS[$KEY]:-}" ]]; then
		echo "Error: Supabase env var $KEY was not produced." >&2
		INVALID_DB_VARS=1
	fi
done
if [[ "$INVALID_DB_VARS" -ne 0 ]]; then
	fail 1
fi

while IFS= read -r LINE; do
	[[ -z "$LINE" ]] && continue
	KEY="${LINE%%=*}"
	VALUE="${LINE#*=}"
	if grep -q "^${KEY}=" .env.local; then
		sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" .env.local
	else
		echo "${KEY}=${VALUE}" >> .env.local
	fi
	echo "${KEY}=${VALUE}" >>"$ENV_FILE"
done <<<"$DB_VARS"
echo "DEFAULT_USER=${DEFAULT_USER:-dev@example.com}" >>"$ENV_FILE"
echo "DEFAULT_PASSWORD=${DEFAULT_PASSWORD}" >>"$ENV_FILE"

# --- seed (fast path) or reset (registry-throttle retry) --------------------
# `supabase start` above already applied every migration, so on a cold runner
# `db:reset` exists only to seed a known-clean database: it drops the DB and
# replays all migrations a second time to get there. db:ci-seed does the seed
# (plus gen-types + the privilege/option-catalog checks) against the stack start
# just built, and exits 3 if the DB is not in a freshly-started state, in which
# case we fall back to the full reset. Fallback is always safe: db:reset drops
# whatever a partial fast path left behind. See scripts/db/ci-seed-fresh.ts.
RESET_BEGIN=$SECONDS
SEED_MODE="seed-only"
set +e
npm run db:ci-seed 2>&1 | tee "$LOG_DIR/db-ci-seed.log"
SEED_RC=${PIPESTATUS[0]}
set -e
if [ "$SEED_RC" = "3" ]; then
	echo "::warning::db:ci-seed preconditions not met (see log above); falling back to db:reset"
	SEED_MODE="full-reset"
	bash scripts/db/ci-db-retry.sh db:reset "$LOG_DIR/db-reset.log" || fail $?
elif [ "$SEED_RC" != "0" ]; then
	fail "$SEED_RC"
fi
RESET_SECONDS=$((SECONDS - RESET_BEGIN))

# Surface the prewarm outcome in the tail the workflow prints. By now the pull
# has long finished (it overlapped start + migrate + seed), so this is ~free.
if [ -n "$PREWARM_PID" ]; then
	wait "$PREWARM_PID" || true
	if [ -f "$LOG_DIR/prewarm-postgres-meta.log" ]; then
		cat "$LOG_DIR/prewarm-postgres-meta.log"
	fi
fi

echo "ci-bootstrap: db:start ${START_SECONDS}s + ${SEED_MODE} ${RESET_SECONDS}s = ${SECONDS}s total"

write_rc 0
exit 0
