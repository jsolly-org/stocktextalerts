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

# --- start (registry-throttle retry) -----------------------------------------
bash scripts/db/ci-db-retry.sh db:start "$LOG_DIR/db-start.log" || fail $?

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

# --- reset (registry-throttle retry; also runs privilege + option-catalog) ---
bash scripts/db/ci-db-retry.sh db:reset "$LOG_DIR/db-reset.log" || fail $?

write_rc 0
exit 0
