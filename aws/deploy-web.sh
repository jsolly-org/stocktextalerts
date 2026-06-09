#!/usr/bin/env bash
# Code-only production deploy for stocktextalerts: Supabase migrations → Vercel
# (prebuilt) → Lambda code. Ports both jobs of the old .github/workflows/deploy.yml.
#
# Runs from the pre-push hook (scripts/prepush.sh) on push to main, and is also
# wired as `npm run deploy` for manual use. NO CloudFormation/SAM infra changes
# happen here — `aws lambda update-function-code` is code-only. Infra/template
# changes stay a manual `npm run deploy:aws` (full SAM, admin creds).
#
# Credentials (gitignored .env.local; chmod 600):
#   PRODUCTION_SITE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF,
#   POSTGRES_PASSWORD, VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID,
#   AWS_PROFILE (scoped assume-role profile — see AGENTS.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Phase 0: load + validate credentials ---
# Allowlist-load ONLY the deploy creds from .env.local — never `set -a` the
# whole file: the rest of it (prod service keys, Twilio, vendor keys) must not
# reach the deploy's child processes (sam/zip/aws/vercel).
DEPLOY_VARS=(PRODUCTION_SITE_URL SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF
  POSTGRES_PASSWORD VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID AWS_PROFILE)
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
: "${PRODUCTION_SITE_URL:?set PRODUCTION_SITE_URL in .env.local (e.g. https://www.stocktextalerts.com)}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN in .env.local}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF in .env.local}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env.local}"
: "${VERCEL_TOKEN:?set VERCEL_TOKEN in .env.local}"
: "${VERCEL_ORG_ID:?set VERCEL_ORG_ID in .env.local}"
: "${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID in .env.local}"
: "${AWS_PROFILE:?set AWS_PROFILE in .env.local (scoped fleet-deploy profile)}"
export VERCEL_ORG_ID VERCEL_PROJECT_ID

# `--preflight`: validate creds only (the pre-push gate calls this before the
# battery so a missing credential fails in seconds, not after 15 minutes).
if [ "${1:-}" = "--preflight" ]; then
  echo "✓ deploy credentials present"
  exit 0
fi

echo "▶ stocktextalerts production deploy"
phase="init"
trap 'echo "✗ deploy failed during: $phase — completed phases remain LIVE (no rollback). Fix and re-run: npm run deploy" >&2' ERR

# --- Phase 1: prebuilt production build ---
# astro.config.ts derives `site` from VERCEL_PROJECT_PRODUCTION_URL (the old
# deploy.yml passed PRODUCTION_SITE_URL under that name — keep the mapping or
# prod pages bake .env.local's localhost VERCEL_URL into canonicals/sitemap).
# SKIP_VENDOR_HTTP_IN_TEST=1 preserves the old CI build's behavior: no live
# vendor HTTP during prerender, so deploys stay deterministic and vendor
# outages can't block a push.
phase="build"
echo "• build (prebuilt, site=$PRODUCTION_SITE_URL)"
VERCEL_PROJECT_PRODUCTION_URL="$PRODUCTION_SITE_URL" SKIP_VENDOR_HTTP_IN_TEST=1 npm run build

# --- Phase 2: Supabase migrations (ONE-WAY — guard hard) ---
phase="supabase migrations"
echo "• supabase link"
SUPABASE_DB_PASSWORD="$POSTGRES_PASSWORD" \
  supabase link --project-ref "$SUPABASE_PROJECT_REF"

# Fail CLOSED: a failed `migration list` (expired token, network) must abort,
# not vacuously pass the drift check in front of a one-way prod db push.
echo "• migration drift check"
if ! migration_list=$(supabase migration list); then
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
  read -r -p "Push migrations to PRODUCTION ($SUPABASE_PROJECT_REF)? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 1; }
else
  echo "• non-interactive (hook) — pushing migrations to PRODUCTION ($SUPABASE_PROJECT_REF) without prompt"
fi
echo "• supabase db push"
supabase db push --include-all --yes

# --- Phase 3: Vercel production deploy (prebuilt) ---
# (Vercel crons were migrated to Lambda/EventBridge in #404 — no cron
# injection into the prebuilt config is needed anymore.)
phase="vercel deploy"
echo "• vercel deploy --prebuilt --prod"
npx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"

# --- Phase 4: Lambda code update (code-only, scoped role) ---
phase="lambda code update"
echo "• build + deploy Lambda code  (AWS_PROFILE=$AWS_PROFILE)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"
(cd aws && sam build --base-dir ..)
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
# freshly migrated schema (the duplicate-SMS incident class).
deploy_code ScheduleFunction stocktextalerts-schedule
deploy_code AssetEventsFunction stocktextalerts-asset-events
deploy_code EmailDispatchFunction stocktextalerts-email-dispatch
deploy_code ComputeDailyStatsFunction stocktextalerts-compute-daily-stats
deploy_code VendorBackfillFunction stocktextalerts-vendor-backfill

echo "✓ stocktextalerts production deploy complete"
