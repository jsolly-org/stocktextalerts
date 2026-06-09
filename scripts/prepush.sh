#!/usr/bin/env bash
# Pre-push gate + deploy for stocktextalerts.
#
# Invoked by .git-hooks/pre-push (core.hooksPath=.git-hooks, wired by `npm run
# prepare`). Replaces .github/workflows/deploy.yml and its run-ci composite: the
# full CI battery and the production deploy now run locally on push to main.
# The cron monitor live-provider-tests.yml is the only surviving workflow.
#
# The gate mirrors docs/ci-with-act.md's local battery and needs local Supabase
# running (db-privileges + test + test:e2e) — start it with `npm run db:start`.
# Deploy is code-only (Lambda update-function-code); infra/template changes stay
# a manual `npm run deploy:aws` (full SAM, admin).
#
# Only acts on a non-deleting push to main/master; feature-branch pushes stay
# fast. Escape hatch: FLEET_SKIP_PREPUSH=1 git push (audited).
set -euo pipefail

if [ "${FLEET_SKIP_PREPUSH:-}" = "1" ]; then
  echo "⚠ FLEET_SKIP_PREPUSH=1 — skipping pre-push gate + deploy" >&2
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# pre-push stdin: <local ref> <local sha> <remote ref> <remote sha>
ZERO="0000000000000000000000000000000000000000"
push_to_main=""
LOCAL_SHA="" REMOTE_SHA=""
while read -r _local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main | refs/heads/master)
      [ "$local_sha" = "$ZERO" ] && continue
      push_to_main="$remote_ref"
      LOCAL_SHA="$local_sha"
      REMOTE_SHA="$remote_sha"
      ;;
  esac
done
[ -z "$push_to_main" ] && exit 0

echo "▶ pre-push gate (stocktextalerts) → $push_to_main"

# --- Quality gate (mirrors run-ci / docs/ci-with-act.md) ---
echo "• biome ci"
npx biome ci . --error-on-warnings
echo "• yaml lint"
npm run check:yaml
echo "• astro check (types)"
npm run check:ts
echo "• markdown lint"
npm run check:md
echo "• knip (unused code)"
npm run check:knip
echo "• squawk migrations"
npm run check:sql
echo "• migration grants (static)"
npm run check:migration-grants
echo "• db privileges (needs local Supabase up)"
npm run check:db-privileges
echo "• unit tests"
npm test
echo "• E2E tests"
npm run test:e2e

# --- Deploy: code-only production deploy (Supabase → Vercel → Lambda code) ---
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$ZERO" ] && git cat-file -e "$REMOTE_SHA" 2>/dev/null; then
  if git diff --name-only "$REMOTE_SHA" "$LOCAL_SHA" | grep -q '^aws/template\.yaml$'; then
    echo "⚠ aws/template.yaml changed — Lambda infra is NOT auto-deployed by this hook."
    echo "  Apply infra manually with admin creds:  npm run deploy:aws   (full SAM)"
  fi
fi
echo "• production deploy"
bash aws/deploy-web.sh
echo "✓ pre-push gate + deploy complete"
