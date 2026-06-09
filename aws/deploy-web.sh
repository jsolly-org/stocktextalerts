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
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
: "${PRODUCTION_SITE_URL:?set PRODUCTION_SITE_URL in .env.local (e.g. https://www.stocktextalerts.com)}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN in .env.local}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF in .env.local}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env.local}"
: "${VERCEL_TOKEN:?set VERCEL_TOKEN in .env.local}"
: "${VERCEL_ORG_ID:?set VERCEL_ORG_ID in .env.local}"
: "${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID in .env.local}"
export VERCEL_ORG_ID VERCEL_PROJECT_ID

echo "▶ stocktextalerts production deploy"

# --- Phase 1: prebuilt production build (bakes PRODUCTION_SITE_URL) ---
echo "• build (prebuilt, PRODUCTION_SITE_URL=$PRODUCTION_SITE_URL)"
PRODUCTION_SITE_URL="$PRODUCTION_SITE_URL" npm run build

# --- Phase 2: Supabase migrations (ONE-WAY — guard hard) ---
echo "• supabase link"
SUPABASE_DB_PASSWORD="$POSTGRES_PASSWORD" \
  supabase link --project-ref "$SUPABASE_PROJECT_REF"

echo "• migration drift check"
remote_versions=$(supabase migration list 2>/dev/null | grep -oE '[0-9]{14}' | sort -u || true)
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
fi
echo "• supabase db push"
supabase db push --include-all --yes

# --- Phase 3: Vercel production deploy (prebuilt) ---
config=".vercel/output/config.json"
if [ -f vercel.json ] && [ -f "$config" ]; then
  crons=$(jq '.crons' vercel.json)
  jq --argjson crons "$crons" '.crons = $crons' "$config" > "$config.tmp" && mv "$config.tmp" "$config"
fi
echo "• vercel deploy --prebuilt --prod"
npx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"

# --- Phase 4: Lambda code update (code-only, scoped role) ---
echo "• build + deploy Lambda code  (AWS_PROFILE=${AWS_PROFILE:-<shell default>})"
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
deploy_code ScheduleFunction stocktextalerts-schedule
deploy_code AssetEventsFunction stocktextalerts-asset-events
deploy_code ComputeDailyStatsFunction stocktextalerts-compute-daily-stats

echo "✓ stocktextalerts production deploy complete"
