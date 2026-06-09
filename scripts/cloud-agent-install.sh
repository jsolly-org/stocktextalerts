#!/usr/bin/env bash
# Cursor Cloud environment bootstrap — see .agents/docs/cloud-agents.md and .cursor/environment.json.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
# Fleet cloud-install lib exists only when the cloud bridge is wired (currently deferred).
if [ -f "$REPO_ROOT/.agents/scripts/cloud-install-lib.sh" ]; then
  source "$REPO_ROOT/.agents/scripts/cloud-install-lib.sh"
fi
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/cloud-install-supabase.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/cloud-install-playwright.sh"

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

# pip --user / pipx tools (yamllint, etc.) install to ~/.local/bin. The fleet helper
# ensure_user_local_bin_on_path only exports PATH for this install process, so later
# interactive shells (e.g. the pre-commit check:yaml step) cannot find them. Persist the
# entry to ~/.bashrc, mirroring persist_cursor_node_shell from cloud-install-lib.sh.
persist_user_local_bin_on_path() {
	local marker="cursor-cloud-agent-local-bin"
	local profile="$HOME/.bashrc"

	if [[ ! -f "$profile" ]] || grep -q "$marker" "$profile" 2>/dev/null; then
		return 0
	fi

	cat >>"$profile" <<'EOF'

# --- cursor-cloud-agent-local-bin (scripts/cloud-agent-install.sh) ---
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# --- end cursor-cloud-agent-local-bin ---
EOF
}

cloud_install_phase "Node 24 + npm ci"
if type use_node_for_cursor_cloud >/dev/null 2>&1; then
  use_node_for_cursor_cloud
else
  echo "fleet cloud-install-lib absent; using VM default Node (cloud bridge deferred)" >&2
fi
npm_ci_for_cloud "$REPO_ROOT"

SUPABASE_BIN="$REPO_ROOT/node_modules/.bin/supabase"
ensure_supabase_cli_for_cloud "$REPO_ROOT"

ensure_user_local_bin_on_path
persist_user_local_bin_on_path
cloud_install_phase "YAML linters + SAM"
install_yaml_linters
install_sam

cloud_install_phase "Docker for Supabase"
install_docker_for_supabase

export PATH="$REPO_ROOT/node_modules/.bin:${PATH}"

# Supabase + db:reset before Playwright — unit tests need the DB; E2E browsers must not block boot.
cloud_install_phase "Supabase start + .env.local"
supabase_start_for_cloud "$SUPABASE_BIN"

CLOUD_STATIC_VARS=$'UNSUBSCRIBE_TOKEN_SECRET=cloud-unsubscribe-secret\nVERCEL_URL=http://localhost:4322\nTWILIO_ACCOUNT_SID=AC00000000000000000000000000000000\nTWILIO_AUTH_TOKEN=cloud-twilio-auth-token\nTWILIO_PHONE_NUMBER=+15555550100\nTWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=cloud-dummy-secret\nAWS_REGION=us-east-1\nEMAIL_FROM=cloud@example.com\nMASSIVE_API_KEY=cloud-massive-api-key\nFINNHUB_API_KEY=cloud-finnhub-api-key'
write_cloud_env_local_from_supabase "$SUPABASE_BIN" "$REPO_ROOT/.env.local" "$CLOUD_STATIC_VARS"

if [[ ! -f .env ]] && [[ -f env.example ]]; then
	cp env.example .env
fi

cloud_install_phase "db:reset + db:doctor"
db_reset_for_cloud
npm run db:doctor

cloud_install_phase "Playwright browsers (E2E)"
install_playwright_browsers_for_cloud

trap - ERR
cloud_install_log "complete — Supabase up, .env.local written, db:reset + db:doctor ok; Playwright attempted"
