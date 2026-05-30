#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.agents/scripts/cloud-install-lib.sh"

# Cursor VMs put exec-daemon Node 22 ahead of nvm on PATH — ensure_node_version alone is not enough.
ensure_node_version
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
	# shellcheck source=/dev/null
	. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
	export PATH="$(dirname "$(nvm which "$(tr -d '[:space:]' < .nvmrc 2>/dev/null || echo 24)")"):$PATH"
fi
if ! node -v | grep -qE '^v24\.'; then
	echo "Expected Node 24 after nvm setup, got: $(node -v)" >&2
	exit 1
fi

persist_node_24_shell() {
	local marker="cursor-cloud-agent-node24"
	local profile="$HOME/.bashrc"

	if [[ ! -f "$profile" ]] || grep -q "$marker" "$profile" 2>/dev/null; then
		return 0
	fi

	cat >>"$profile" <<'EOF'

# --- cursor-cloud-agent-node24 (repo cloud-agent-install.sh) ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null 2>&1 || true
nvm use 24 >/dev/null 2>&1 || true
if nvm which 24 >/dev/null 2>&1; then
  export PATH="$(dirname "$(nvm which 24)"):$PATH"
fi
# --- end cursor-cloud-agent-node24 ---
EOF
}

persist_node_24_shell

npm ci
install_yaml_linters
install_sam

if ! command -v supabase >/dev/null 2>&1; then
	curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install.sh | sh
fi

npx playwright install chromium --with-deps

supabase start -x studio,imgproxy,logflare,vector,postgres-meta,edge-runtime,realtime,storage-api

supabase status -o json > /tmp/sb-status.json
DB_VARS="$(jq -r '
  "SUPABASE_URL=\(.API_URL // "")",
  "SUPABASE_PUBLISHABLE_KEY=\(.ANON_KEY // "")",
  "SUPABASE_SECRET_KEY=\(.SERVICE_ROLE_KEY // "")",
  "DATABASE_URL=\(.DB_URL // "")"
' /tmp/sb-status.json)"
INVALID_DB_VARS=0
DB_VARS_NONEMPTY_LINES=0
declare -A DB_VARS_SEEN_KEYS=()
while IFS= read -r LINE; do
	[[ -z "$LINE" ]] && continue
	DB_VARS_NONEMPTY_LINES=$((DB_VARS_NONEMPTY_LINES + 1))
	if [[ "$LINE" != *"="* ]]; then
		echo "Error: Supabase env var line is malformed (expected KEY=VALUE): $LINE" >&2
		INVALID_DB_VARS=1
		continue
	fi
	KEY="${LINE%%=*}"
	VALUE="${LINE#*=}"
	DB_VARS_SEEN_KEYS["$KEY"]=1
	VALUE_TRIMMED="${VALUE//[[:space:]]/}"
	if [[ -z "$VALUE_TRIMMED" || "$VALUE" == "null" ]]; then
		echo "Error: Supabase status did not provide a valid value for $KEY (got '$VALUE')." >&2
		INVALID_DB_VARS=1
	fi
done <<< "$DB_VARS"
for KEY in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY DATABASE_URL; do
	if [[ -z "${DB_VARS_SEEN_KEYS[$KEY]:-}" ]]; then
		echo "Error: Supabase env var $KEY was not produced by jq." >&2
		INVALID_DB_VARS=1
	fi
done
if [[ "$DB_VARS_NONEMPTY_LINES" -eq 0 ]]; then
	echo "Error: jq produced no Supabase env vars." >&2
	INVALID_DB_VARS=1
fi
if [[ "$INVALID_DB_VARS" -ne 0 ]]; then
	echo "Error: Refusing to export Supabase env vars with null/empty values." >&2
	exit 1
fi
STATIC_VARS=$'UNSUBSCRIBE_TOKEN_SECRET=cloud-unsubscribe-secret\nVERCEL_URL=http://localhost:4322\nTWILIO_ACCOUNT_SID=AC00000000000000000000000000000000\nTWILIO_AUTH_TOKEN=cloud-twilio-auth-token\nTWILIO_PHONE_NUMBER=+15555550100\nTWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=cloud-dummy-secret\nAWS_REGION=us-east-1\nEMAIL_FROM=cloud@example.com\nMASSIVE_API_KEY=cloud-massive-api-key\nFINNHUB_API_KEY=cloud-finnhub-api-key'
printf '%s\n%s\n' "$DB_VARS" "$STATIC_VARS" > .env.local

if [ ! -f .env ] && [ -f env.example ]; then
	cp env.example .env
fi
