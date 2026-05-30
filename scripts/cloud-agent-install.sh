#!/usr/bin/env bash
# Cursor Cloud environment bootstrap — see docs/cloud-agents.md and .cursor/environment.json.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
source "$REPO_ROOT/.agents/scripts/cloud-install-lib.sh"

use_node_for_cursor_cloud
npm ci

ensure_user_local_bin_on_path
install_yaml_linters
install_sam
install_docker_for_supabase

SUPABASE_BIN="$REPO_ROOT/node_modules/.bin/supabase"
if [[ ! -x "$SUPABASE_BIN" ]]; then
	echo "Error: Supabase CLI not found at $SUPABASE_BIN (expected npm devDependency after npm ci)." >&2
	exit 1
fi
export PATH="$REPO_ROOT/node_modules/.bin:${PATH}"

npx playwright install chromium --with-deps

supabase_start_for_cloud "$SUPABASE_BIN"

CLOUD_STATIC_VARS=$'UNSUBSCRIBE_TOKEN_SECRET=cloud-unsubscribe-secret\nVERCEL_URL=http://localhost:4322\nTWILIO_ACCOUNT_SID=AC00000000000000000000000000000000\nTWILIO_AUTH_TOKEN=cloud-twilio-auth-token\nTWILIO_PHONE_NUMBER=+15555550100\nTWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=cloud-dummy-secret\nAWS_REGION=us-east-1\nEMAIL_FROM=cloud@example.com\nMASSIVE_API_KEY=cloud-massive-api-key\nFINNHUB_API_KEY=cloud-finnhub-api-key'
write_cloud_env_local_from_supabase "$SUPABASE_BIN" "$REPO_ROOT/.env.local" "$CLOUD_STATIC_VARS"

if [[ ! -f .env ]] && [[ -f env.example ]]; then
	cp env.example .env
fi

# Migrations + generated seed + types — matches local db:bootstrap intent for npm test.
npm run db:reset

npm run db:doctor

echo "cloud-agent-install: Supabase up, .env.local written, db:reset + db:doctor ok"
