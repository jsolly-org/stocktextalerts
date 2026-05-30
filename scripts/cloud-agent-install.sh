#!/usr/bin/env bash
# Cursor Cloud environment bootstrap — see .agents/docs/cloud-agents.md and .cursor/environment.json.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.agents/scripts/cloud-install-lib.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/cloud-install-supabase.sh"

# Set CLOUD_INSTALL_DEBUG=1 for bash -x trace (e.g. in environment.json install command).
if [[ "${CLOUD_INSTALL_DEBUG:-}" == "1" ]]; then
	set -x
	cloud_install_log "debug trace enabled (CLOUD_INSTALL_DEBUG=1)"
fi

cloud_install_on_error() {
	local exit_code=$?
	local line=$1
	local cmd=$2
	echo "cloud-agent-install: FAILED at line $line: $cmd (exit $exit_code)" >&2
	if type dump_supabase_diagnostics &>/dev/null; then
		dump_supabase_diagnostics "${SUPABASE_BIN:-supabase}" || true
	elif type dump_docker_diagnostics &>/dev/null; then
		dump_docker_diagnostics || true
	fi
	exit "$exit_code"
}
trap 'cloud_install_on_error $LINENO "$BASH_COMMAND"' ERR

cloud_install_phase() {
	cloud_install_log "phase — $1"
}

cloud_install_phase "Node 24 + npm ci"
use_node_for_cursor_cloud
npm ci

ensure_user_local_bin_on_path
cloud_install_phase "YAML linters + SAM"
install_yaml_linters
install_sam

cloud_install_phase "Docker for Supabase"
install_docker_for_supabase

SUPABASE_BIN="$REPO_ROOT/node_modules/.bin/supabase"
if [[ ! -x "$SUPABASE_BIN" ]]; then
	echo "Error: Supabase CLI not found at $SUPABASE_BIN (expected npm devDependency after npm ci)." >&2
	exit 1
fi
export PATH="$REPO_ROOT/node_modules/.bin:${PATH}"

cloud_install_phase "Playwright browsers (E2E)"
install_playwright_browsers_for_e2e

cloud_install_phase "Supabase start + .env.local"
supabase_start_for_cloud "$SUPABASE_BIN"

CLOUD_STATIC_VARS=$'UNSUBSCRIBE_TOKEN_SECRET=cloud-unsubscribe-secret\nVERCEL_URL=http://localhost:4322\nTWILIO_ACCOUNT_SID=AC00000000000000000000000000000000\nTWILIO_AUTH_TOKEN=cloud-twilio-auth-token\nTWILIO_PHONE_NUMBER=+15555550100\nTWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=cloud-dummy-secret\nAWS_REGION=us-east-1\nEMAIL_FROM=cloud@example.com\nMASSIVE_API_KEY=cloud-massive-api-key\nFINNHUB_API_KEY=cloud-finnhub-api-key'
write_cloud_env_local_from_supabase "$SUPABASE_BIN" "$REPO_ROOT/.env.local" "$CLOUD_STATIC_VARS"

if [[ ! -f .env ]] && [[ -f env.example ]]; then
	cp env.example .env
fi

cloud_install_phase "db:reset + db:doctor"
npm run db:reset
npm run db:doctor

trap - ERR
cloud_install_log "complete — Supabase up, .env.local written, db:reset + db:doctor ok"
