#!/usr/bin/env bash
# Production deploy for stocktextalerts. The irreversible phase order is deliberate:
#   Phase 1  build the Lambda bundle  (offline, side-effect-free — esbuild via `sam build`)
#   Phase 2  Supabase migrations      (ONE-WAY — guard hard)
#   Phase 3  Lambda code update       (upload the Phase 1 bundle; code-only, scoped role)
#   Phase 4  local break-glass only: Vercel web deploy via CLI
#
# Build FIRST so a build failure aborts with prod UNTOUCHED. (2026-06-21 incident: a native
# `.node` esbuild break in @resvg/resvg-js aborted the deploy AFTER `supabase db push` had already
# migrated prod, leaving prod DB ahead of prod code.) Invariant: never run an irreversible step
# before every reversible validation that can fail has passed. The build is offline, so it owes
# nothing to the migration; reordering it ahead is free and removes the whole failure class.
#
# The GitHub Actions deploy path does NOT deploy the web tier here. Vercel's GitHub integration owns
# web deploys from main, while this script owns production Supabase migrations, Lambda code updates,
# and live-provider verification. The local break-glass path still deploys Vercel via the pinned CLI
# after migrations + Lambda updates.
#
# Runs from the GitHub production deploy workflow with --deploy-ci, and is also wired as
# `npm run deploy:code` for local break-glass use. NO CloudFormation/SAM infra changes happen here
# — `aws lambda update-function-code` is code-only. Infra/template changes stay a manual
# `npm run deploy:infra` (full SAM, admin creds).
#
# Modes:
#   (no arg)     full production deploy (Phases 1–4).
#   --build      Phase 1 only — build the Lambda bundle. No AWS/DB/Vercel creds needed. The
#                pre-push gate's fail-fast build check, also exposed as `npm run build:lambdas`.
#   --preflight  validate deploy credentials only (AWS + prod DB + Vercel), then exit.
#   --deploy-ci  production migration + Lambda deploy from GitHub Actions. Uses OIDC-provided AWS
#                credentials and env-provided DATABASE_URL_PROD/PRODUCTION_SITE_URL. Vercel web
#                deploys are handled by the Vercel GitHub integration.
#
# Credentials (gitignored .env.local; chmod 600):
#   DATABASE_URL_PROD (full prod Postgres URL — migrations connect with it directly; no supabase
#   link / access token / separate password needed),
#   AWS_PROFILE (scoped assume-role profile — see AGENTS.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ROOT="$REPO_ROOT"
MODE="${1:-}"
CI_DEPLOY=false
[ "$MODE" = "--deploy-ci" ] && CI_DEPLOY=true

# Shared fleet gate helpers (dotagents/gate/gate-lib.sh) — sourced the same way .git-hooks/pre-push
# does, purely for gate_npm_ci below (sourcing has no side effects). gate_npm_ci resolves the repo
# root from $PWD, which is REPO_ROOT after the cd above. CI runners have no dotagents checkout;
# --build/--deploy-ci there skip gate-lib (npm ci already ran in the workflow).
_gate_lib="${DOTAGENTS_GATE_LIB:-$HOME/code/dotagents/gate/gate-lib.sh}"
if [ -f "$_gate_lib" ]; then
  # shellcheck source=/dev/null
  source "$_gate_lib"
elif [ "${CI:-}" = "true" ] && { [ "$MODE" = "--build" ] || [ "$CI_DEPLOY" = "true" ]; }; then
  :
else
  echo "✗ dotagents gate-lib not found (expected ~/code/dotagents/gate/gate-lib.sh) — re-run install-local-agent-runtime.sh." >&2
  exit 1
fi

# Ground aws/sam to the repo-pinned versions (.mise.toml) — the pre-push hook runs
# non-interactively, so the shell profile's mise activation isn't loaded. Guarded so a machine
# without mise degrades to the global aws/sam on $PATH (rules/tool-versions.md). The presence
# guards below then verify the pinned tool resolved.
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)"

# Repo-pinned bins on PATH (esbuild for `sam build`, the supabase/vercel/tsx CLIs) — never the
# machine-global versions (rules/dependency-grounding.md). Exported ahead of the mode dispatch so
# --build, --preflight, and the full deploy all resolve the pinned binaries by bare name.
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

# Ground the SAM CLI: not an npm dep — fail loud if absent (rules/dependency-grounding.md).
command -v sam >/dev/null 2>&1 || { echo "✗ sam CLI not found — brew install aws-sam-cli" >&2; exit 1; }

deploy_vercel_production() {
  if [ "$CI_DEPLOY" = "true" ]; then
    echo "• Vercel web deploy handled by Vercel GitHub integration"
    return
  fi

  if [ "$CI_DEPLOY" != "true" ] && declare -F gate_deploy_vercel >/dev/null 2>&1; then
    gate_deploy_vercel team_T8yHg0aDz7nCbyBgJh5a2saR prj_wrSGjuWe4w82AdjlQAI3b60PSypJ
    return
  fi

  : "${VERCEL_TOKEN:?set VERCEL_TOKEN for local Vercel CLI deploy fallback}"
  : "${VERCEL_ORG_ID:?set VERCEL_ORG_ID for local Vercel CLI deploy fallback}"
  : "${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID for local Vercel CLI deploy fallback}"

  local vercel="$REPO_ROOT/node_modules/.bin/vercel"
  echo "• vercel pull --environment=production"
  "$vercel" pull --yes --environment=production --token "$VERCEL_TOKEN"
  echo "• vercel build --prod"
  "$vercel" build --prod --yes --token "$VERCEL_TOKEN"
  echo "• vercel deploy --prebuilt --prod"
  "$vercel" deploy --prebuilt --prod --yes --token "$VERCEL_TOKEN"
}

# Build the Lambda bundle (esbuild via `sam build`, into aws/.aws-sam/build). Offline and
# side-effect-free. Stamps the real release-id, builds, then ALWAYS restores the committed stub —
# even when the build fails — so a broken build never leaves src/lib/logging/release-id.ts modified
# (that would trip gate_require_clean_tree on the next push; this repo has stub-dirtying history,
# commits ee70c6b/b6c74e5). The build's exit code still propagates so a failure aborts the caller.
build_lambdas() {
  # Reproducible bundle: reinstall the committed lockfile before `sam build` bundles the Lambda from
  # gitignored node_modules. --if-stale because both callers reach here — the push path runs from a
  # freshly worktree:init'd tree (in sync → skipped, no wasted reinstall), while the manual
  # `npm run deploy:code` / `npm run build:lambdas` can run from a possibly-stale checkout (the read-only
  # `main` mirror is never npm ci'd in the worktree-first flow → reinstall). Runs before the tsx
  # steps so they too resolve from a fresh node_modules/.bin. Credential-free, so safe in --build.
  if declare -F gate_npm_ci >/dev/null 2>&1; then
    gate_npm_ci --if-stale
  elif [ "${CI:-}" != "true" ]; then
    npm ci
  fi
  echo "• build Lambda bundle (sam build — esbuild)"
  tsx scripts/gen-release-id.ts
  local rc=0
  (cd aws && sam build --base-dir ..) || rc=$?
  # `|| rc=$?` on BOTH lines: it keeps set -e from aborting before the restore runs (so the stub is
  # restored even on a build failure) AND lets a restore failure itself fail the caller — `return`
  # always fires, and rc is non-zero if either step failed, so we never silently proceed dirty.
  tsx scripts/restore-release-stub.ts || rc=$?
  return "$rc"
}

# --- Mode: --build (Phase 1 only — no creds) -------------------------------------------------
# Offline bundle build. The pre-push gate runs this as a fast preflight so an esbuild break (the
# resvg .node class) fails the push in seconds — before the test battery and, crucially, before the
# deploy's one-way Supabase migration. Also `npm run build:lambdas` for a credential-free local check.
if [ "$MODE" = "--build" ]; then
  build_lambdas
  echo "✓ Lambda bundle builds"
  exit 0
fi

# --- Phase 0: load + validate credentials ---
# Allowlist-load ONLY the deploy creds from .env.local — never `set -a` the
# whole file: the rest of it (prod service keys, Twilio, vendor keys) must not
# reach the deploy's child processes (sam/zip/aws).
DEPLOY_VARS=(DATABASE_URL_PROD PRODUCTION_SITE_URL)
if [ "$CI_DEPLOY" != "true" ]; then
  DEPLOY_VARS+=(AWS_PROFILE)
fi
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
# let them leak into the local scoped-role deploy. GitHub Actions intentionally
# supplies short-lived AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN
# after OIDC federation, so keep them for --deploy-ci.
if [ "$CI_DEPLOY" != "true" ]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi
: "${DATABASE_URL_PROD:?set DATABASE_URL_PROD in .env.local (full prod Postgres URL)}"
if [ "$CI_DEPLOY" != "true" ]; then
  : "${AWS_PROFILE:?set AWS_PROFILE in .env.local (scoped fleet-deploy profile)}"
fi
: "${PRODUCTION_SITE_URL:?set PRODUCTION_SITE_URL in .env.local (canonical production URL for local vercel build)}"
# Migrations must NOT run through the transaction-mode pooler (port 6543) —
# DDL wants a session connection. Same pooler host serves session mode on 5432.
DB_URL="${DATABASE_URL_PROD/:6543\//:5432/}"

# Ground the system/npm CLIs the deploy + preflight shell out to (aws is not an npm dep — fail loud
# if absent; supabase is, but a fresh worktree without `npm ci` would miss it).
command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found — brew install awscli" >&2; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "✗ supabase CLI missing — run npm ci" >&2; exit 1; }

# --- Mode: --preflight (validate creds only) -------------------------------------------------
# Validate BOTH deploy credentials only (the pre-push gate calls this before the battery so a
# credential problem fails in seconds, not after 15 minutes). Each check exercises the SAME path the
# deploy later uses, so it catches what the `:?` presence checks above cannot:
#   - AWS: `sts get-caller-identity` over the exported AWS_PROFILE (no explicit --profile) → catches
#     an expired SSO token before Phase 3's Lambda update.
#   - prod DB: `supabase migration list` over DB_URL → catches a stale/rotated DATABASE_URL_PROD
#     before Phase 2's one-way `supabase db push`.
#   - Vercel: `vercel whoami` → catches a logged-out CLI now, before Phase 2 migrates prod, so the
#     web deploy (Phase 4, after the one-way migration) can't be what fails.
if [ "$MODE" = "--preflight" ]; then
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "✗ AWS credentials for profile '$AWS_PROFILE' do not resolve (likely an expired SSO token)." >&2
    echo "  Refresh your SSO session and retry the push, e.g.:  aws sso login --sso-session <your-session>" >&2
    exit 1
  fi
  if ! supabase migration list --db-url "$DB_URL" >/dev/null 2>&1; then
    echo "✗ production database unreachable — check DATABASE_URL_PROD (host/password) and network." >&2
    echo "  (If the supabase CLI is missing, run npm ci.)" >&2
    exit 1
  fi
  if ! vercel whoami >/dev/null 2>&1; then
    echo "✗ Vercel CLI not authenticated — run:  vercel login" >&2
    exit 1
  fi
  echo "✓ deploy credentials valid (AWS $AWS_PROFILE + prod DB + Vercel)"
  exit 0
fi

echo "▶ stocktextalerts production deploy"

# --- Landed-ref guard: deploy ONLY what has landed on origin/main ---
# gate_require_landed (gate-lib, sourced above) fetches and aborts unless HEAD == origin/main's
# landed tip — so this deploy can never ship the local tree before the ref lands (the 2026-06-24
# concurrent-push race) or a stale checkout. Runs only in the full deploy (--build/--preflight exit
# above) and BEFORE the one-way Phase 2 migration.
if [ "$CI_DEPLOY" = "true" ]; then
  echo "• CI deploy mode — landed-ref guard is enforced by GitHub main-branch workflow triggers"
else
  gate_require_landed main
fi

phase="init"
trap 'echo "✗ deploy failed during: $phase — completed phases remain LIVE (no rollback). Fix and re-run: npm run deploy:code" >&2' ERR

# --- Phase 1: build the Lambda bundle FIRST (offline, reversible) ---
# Ahead of the one-way Supabase migration so a build failure leaves prod untouched (see header).
# Always rebuild here even though the pre-push gate's --build preflight already built once — the
# deploy must not depend on a throwaway preflight artifact surviving the battery + a `db push`.
phase="lambda bundle build"
build_lambdas

# --- Phase 2: Supabase migrations (ONE-WAY — guard hard) ---
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

# --- Phase 3: Lambda code update (code-only, scoped role) ---
# Uploads the bundle built in Phase 1 — no rebuild here.
phase="lambda code update"
if [ "$CI_DEPLOY" = "true" ]; then
  echo "• deploy Lambda code  (GitHub Actions OIDC)"
else
  echo "• deploy Lambda code  (AWS_PROFILE=$AWS_PROFILE)"
fi
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
deploy_code AssetMaintenanceFunction stocktextalerts-asset-maintenance
deploy_code EmailDispatchFunction stocktextalerts-email-dispatch
deploy_code ComputeDailyStatsFunction stocktextalerts-compute-daily-stats
deploy_code VendorBackfillFunction stocktextalerts-vendor-backfill
deploy_code LiveProviderCheckFunction stocktextalerts-live-provider-check
deploy_code BackupUserSettingsFunction stocktextalerts-backup-user-settings

# --- Phase 4: Vercel web deploy / Git integration handoff --------------------------------------
# Local break-glass deploys ship Vercel last, against the freshly migrated DB + updated Lambdas.
# GitHub Actions relies on the connected Vercel GitHub integration instead of a VERCEL_TOKEN secret.
# Link via non-secret env vars (the gitignored .vercel/ may be absent in a worktree).
export VERCEL_PROJECT_PRODUCTION_URL="${PRODUCTION_SITE_URL#https://}"
export VERCEL_PROJECT_PRODUCTION_URL="${VERCEL_PROJECT_PRODUCTION_URL#http://}"
phase="vercel web deploy"
deploy_vercel_production

if [ "$CI_DEPLOY" = "true" ]; then
  echo "✓ stocktextalerts production deploy complete (Supabase + Lambda; Vercel via Git integration)"
else
  echo "✓ stocktextalerts production deploy complete (Supabase + Lambda + Vercel web)"
fi
