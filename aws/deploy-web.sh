#!/usr/bin/env bash
# Production deploy for stocktextalerts: Supabase migrations → Lambda code →
# Vercel web. The WEB tier is deployed here via the pinned Vercel CLI because the
# Vercel↔GitHub git integration is disconnected — the push is now the deploy
# trigger. The project link travels as non-secret env vars (VERCEL_ORG_ID /
# VERCEL_PROJECT_ID) so the gitignored .vercel/ dir needn't exist in the worktree.
#
# Runs from the pre-push hook (.git-hooks/pre-push) on push to main, and is also
# wired as `npm run deploy` for manual use. NO CloudFormation/SAM infra changes
# happen here — `aws lambda update-function-code` is code-only. Infra/template
# changes stay a manual `npm run deploy:aws` (full SAM, admin creds).
#
# Credentials (gitignored .env.local; chmod 600):
#   DATABASE_URL_PROD (full prod Postgres URL — migrations connect with it
#   directly; no supabase link / access token / separate password needed),
#   AWS_PROFILE (scoped assume-role profile — see AGENTS.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Ground aws/sam to the repo-pinned versions (.mise.toml) — the pre-push hook runs
# non-interactively, so the shell profile's mise activation isn't loaded. Guarded so a machine
# without mise degrades to the global aws/sam on $PATH (rules/tool-versions.md). The presence
# guards below then verify the pinned tool resolved.
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)"

# --- Phase 0: load + validate credentials ---
# Allowlist-load ONLY the deploy creds from .env.local — never `set -a` the
# whole file: the rest of it (prod service keys, Twilio, vendor keys) must not
# reach the deploy's child processes (sam/zip/aws).
DEPLOY_VARS=(DATABASE_URL_PROD AWS_PROFILE)
if [ -f .env.local ]; then
  for _var in "${DEPLOY_VARS[@]}"; do
    if [ -z "${!_var:-}" ]; then
      _line=$(grep -E "^${_var}=" .env.local | tail -n 1 || true)
      if [ -n "$_line" ]; then
        _val="${_line#*=}"; _val="${_val%\"}"; _val="${_val#\"}"
        export "$_var=$_val"
      fi
    fi
  done
fi
# Static AWS env keys outrank AWS_PROFILE in the CLI credential chain — never
# let them leak into the scoped-role deploy.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
: "${DATABASE_URL_PROD:?set DATABASE_URL_PROD in .env.local (full prod Postgres URL)}"
: "${AWS_PROFILE:?set AWS_PROFILE in .env.local (scoped fleet-deploy profile)}"
# Migrations must NOT run through the transaction-mode pooler (port 6543) —
# DDL wants a session connection. Same pooler host serves session mode on 5432.
DB_URL="${DATABASE_URL_PROD/:6543\//:5432/}"

# Ground the system CLIs this deploy shells out to: aws/sam are NOT npm deps (supabase + vercel are,
# and are path-pinned below) — fail loud if absent, never a hard-coded path (rules/dependency-grounding.md).
command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found — brew install awscli" >&2; exit 1; }
command -v sam >/dev/null 2>&1 || { echo "✗ sam CLI not found — brew install aws-sam-cli" >&2; exit 1; }

# `--preflight`: validate BOTH deploy credentials only (the pre-push gate calls
# this before the battery so a credential problem fails in seconds, not after 15
# minutes). Each check exercises the SAME path the deploy later uses, so it
# catches the failures the `:?` presence checks above cannot:
#   - AWS: `sts get-caller-identity` over the exported AWS_PROFILE (no explicit
#     --profile) → catches an expired SSO token before Phase 2's Lambda update.
#   - prod DB: `supabase migration list` over DB_URL → catches a stale/rotated
#     DATABASE_URL_PROD before Phase 1's one-way `supabase db push`. Uses the
#     repo-pinned binary by path (PATH isn't exported until the deploy body).
if [ "${1:-}" = "--preflight" ]; then
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "✗ AWS credentials for profile '$AWS_PROFILE' do not resolve (likely an expired SSO token)." >&2
    echo "  Refresh your SSO session and retry the push, e.g.:  aws sso login --sso-session <your-session>" >&2
    exit 1
  fi
  if ! "$REPO_ROOT/node_modules/.bin/supabase" migration list --db-url "$DB_URL" >/dev/null 2>&1; then
    echo "✗ production database unreachable — check DATABASE_URL_PROD (host/password) and network." >&2
    echo "  (If the supabase CLI is missing, run npm ci.)" >&2
    exit 1
  fi
  # Vercel auth — catch a logged-out CLI now, before Phase 1 migrates prod, so
  # the web deploy (Phase 3, after the one-way migration) can't be what fails.
  if ! "$REPO_ROOT/node_modules/.bin/vercel" whoami >/dev/null 2>&1; then
    echo "✗ Vercel CLI not authenticated — run:  vercel login" >&2
    exit 1
  fi
  echo "✓ deploy credentials valid (AWS $AWS_PROFILE + prod DB + Vercel)"
  exit 0
fi

echo "▶ stocktextalerts production deploy"
phase="init"
trap 'echo "✗ deploy failed during: $phase — completed phases remain LIVE (no rollback). Fix and re-run: npm run deploy" >&2' ERR

# Repo-pinned CLIs (supabase, sam helpers) resolve from the lockfile, never
# from whatever happens to be on the global PATH.
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"
command -v supabase >/dev/null || { echo "✗ supabase CLI missing — run npm ci" >&2; exit 1; }

# --- Phase 1: Supabase migrations (ONE-WAY — guard hard) ---
# Connects straight to prod Postgres via --db-url: no `supabase link` (which
# would leave the clone persistently linked to prod), no management-API token.
phase="supabase migrations"

# Fail CLOSED: a failed `migration list` (bad URL, network) must abort,
# not vacuously pass the drift check in front of a one-way prod db push.
echo "• migration drift check"
if ! migration_list=$(supabase migration list --db-url "$DB_URL"); then
  echo "ERROR: could not list remote migrations — refusing to push" >&2
  exit 1
fi
remote_versions=$(grep -oE '[0-9]{14}' <<<"$migration_list" | sort -u || true)
if [ -z "$remote_versions" ]; then
  echo "ERROR: remote migration list parsed empty — refusing to push (prod always has applied migrations)" >&2
  exit 1
fi
orphaned=()
for version in $remote_versions; do
  if ! ls supabase/migrations/"${version}"_*.sql >/dev/null 2>&1; then
    orphaned+=("$version")
  fi
done
if [ ${#orphaned[@]} -gt 0 ]; then
  echo "ERROR: migration drift — remote versions with no local file:" >&2
  printf '  - %s\n' "${orphaned[@]}" >&2
  echo "Repair each:  supabase migration repair <version> --status reverted --linked" >&2
  exit 1
fi

if [ -t 0 ]; then
  read -r -p "Push migrations to the PRODUCTION database? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 1; }
else
  echo "• non-interactive (hook) — pushing migrations to the PRODUCTION database without prompt"
fi
echo "• supabase db push"
supabase db push --include-all --yes --db-url "$DB_URL"

# --- Phase 2: Lambda code update (code-only, scoped role) ---
phase="lambda code update"
echo "• build + deploy Lambda code  (AWS_PROFILE=$AWS_PROFILE)"
tsx scripts/gen-release-id.ts
(cd aws && sam build --base-dir ..)
tsx scripts/restore-release-stub.ts  # restore stub after bundling (prevents dirty-tree on next push)
build="aws/.aws-sam/build"
deploy_code() { # <build-dir> <physical-name>
  (cd "$build/$1" && zip -qr "../$1.zip" .)
  aws lambda update-function-code \
    --function-name "$2" --zip-file "fileb://$build/$1.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$2"
  echo "  ✓ $2"
}
# Keep this list in sync with aws/template.yaml — ALL functions share src/lib,
# so every function must ship on every push or stale code runs against the
# freshly migrated schema (the duplicate-SMS incident class). The
# `check:deploy-functions` gate (npm run check:deploy-functions) fails the push
# if this list drifts from the template's AWS::Serverless::Function set.
deploy_code ScheduleFunction stocktextalerts-schedule
deploy_code AssetEventsFunction stocktextalerts-asset-events
deploy_code EmailDispatchFunction stocktextalerts-email-dispatch
deploy_code ComputeDailyStatsFunction stocktextalerts-compute-daily-stats
deploy_code VendorBackfillFunction stocktextalerts-vendor-backfill
deploy_code LiveProviderCheckFunction stocktextalerts-live-provider-check
deploy_code BackupUserSettingsFunction stocktextalerts-backup-user-settings

# --- Phase 3: Vercel web deploy (remote build) ---
# Last, so the web tier ships against the freshly migrated DB + updated Lambdas.
# Link via non-secret env vars (the gitignored .vercel/ may be absent in a worktree).
phase="vercel web deploy"
echo "• vercel deploy --prod"
VERCEL_ORG_ID=team_T8yHg0aDz7nCbyBgJh5a2saR \
VERCEL_PROJECT_ID=prj_wrSGjuWe4w82AdjlQAI3b60PSypJ \
  vercel deploy --prod --yes

echo "✓ stocktextalerts production deploy complete (Supabase + Lambda + Vercel web)"
