#!/usr/bin/env bash
# Pre-push gate + deploy for stocktextalerts.
#
# Invoked by .git-hooks/pre-push (core.hooksPath=.git-hooks, wired by `npm run
# prepare`). The full CI battery and the production deploy run locally on push
# to main. The live vendor-API health check runs as the scheduled
# stocktextalerts-live-provider-check Lambda.
#
# The gate mirrors docs/prepush-gate.md's local battery and needs local Supabase
# running (db-privileges + test + test:e2e) — start it with `npm run db:start`.
# Deploy is code-only (Lambda update-function-code); infra/template changes stay
# a manual `npm run deploy:aws` (full SAM, admin).
#
# Only acts on a non-deleting push to main/master; feature-branch pushes stay
# fast. Escape hatch: FLEET_SKIP_PREPUSH=1 git push.
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

# --- Markdown lint -----------------------------------------------------------
# Run whenever the pushed range touches markdown, BEFORE the docs-only fast path
# below, so docs-only (and mixed) pushes always lint their markdown and then the
# fast path still skips the expensive gate + deploy. Cheap. Fail-safe: lint when
# the range cannot be computed.
prepush_md_changed() { # <remote_sha> <local_sha>
  local remote_sha="$1" local_sha="$2" f
  [ -n "$remote_sha" ] && [ "$remote_sha" != "$ZERO" ] || return 0
  git cat-file -e "$remote_sha" 2>/dev/null || return 0
  git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null || return 0
  while IFS= read -r f; do
    case "$f" in *.md | *.mdx | *.markdown) return 0 ;; esac
  done < <(git diff --name-only "$remote_sha" "$local_sha")
  return 1
}
if prepush_md_changed "$REMOTE_SHA" "$LOCAL_SHA"; then
  echo "• markdown lint"
  bash "$ROOT/scripts/lint-md.sh"
fi

# --- Doc-only fast path -------------------------------------------------------
# Skip the gate AND deploy when the pushed range touches only documentation —
# no code/migrations changed, so there is nothing to ship. Conservative allow-
# list: root-level *.md, the docs/ tree, .github/*.md, and LICENSE — markdown
# that is site CONTENT (under src/, content/, …) still runs the full gate. Falls
# back to the full gate whenever the range can't be computed (new branch, non-
# fast-forward, missing remote sha), so it can only skip too little, never too
# much. Force the full gate with:  FLEET_DOC_FAST=0 git push
prepush_doc_only() { # <remote_sha> <local_sha>  → 0 when the fast path applies
  local remote_sha="$1" local_sha="$2" files f
  [ "${FLEET_DOC_FAST:-1}" = "1" ] || return 1
  [ -n "$remote_sha" ] && [ "$remote_sha" != "$ZERO" ] || return 1
  git cat-file -e "$remote_sha" 2>/dev/null || return 1
  git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null || return 1
  files="$(git diff --name-only "$remote_sha" "$local_sha")" || return 1
  [ -n "$files" ] || return 1
  while IFS= read -r f; do
    case "$f" in
      docs/*) ;;
      .github/*.md) ;;
      *.md | *.mdx | *.markdown) [ "${f%/*}" = "$f" ] || return 1 ;;
      LICENSE | LICENSE.*) ;;
      *) return 1 ;;
    esac
  done <<<"$files"
  return 0
}
if prepush_doc_only "$REMOTE_SHA" "$LOCAL_SHA"; then
  echo "▶ pre-push (stocktextalerts) → $push_to_main: docs-only change — skipping the full gate + deploy."
  exit 0
fi

echo "▶ pre-push gate (stocktextalerts) → $push_to_main"
trap 'echo "✗ pre-push gate failed — nothing deployed; push aborted" >&2' ERR

# The gate and deploy validate the WORKING TREE — refuse if it differs from
# the pushed commit, or prod would ship code that never lands on main.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree dirty — commit or stash so the gate tests exactly what ships" >&2
  exit 1
fi
if [ "$LOCAL_SHA" != "$(git rev-parse HEAD)" ]; then
  echo "✗ pushed SHA is not HEAD — push from the checkout being validated" >&2
  exit 1
fi
# Non-fast-forward guard: git rejects the push only AFTER this hook, so a
# stale clone would deploy prod and then have its push bounced.
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$ZERO" ] && git cat-file -e "$REMOTE_SHA" 2>/dev/null; then
  if ! git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA"; then
    echo "✗ remote main advanced (non-fast-forward) — pull/rebase before pushing" >&2
    exit 1
  fi
fi

# Cheap preflights — fail in seconds, not after the 15-minute battery.
echo "• deploy creds preflight"
bash aws/deploy-web.sh --preflight
echo "• db doctor (needs local Supabase up — npm run db:start)"
npm run db:doctor

# --- Quality gate (the old run-ci battery — see docs/prepush-gate.md) ---
echo "• biome ci"
npx biome ci . --error-on-warnings
echo "• yaml lint"
npm run check:yaml
echo "• astro check (types)"
npm run check:ts
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
infra_changed=""
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$ZERO" ] && git cat-file -e "$REMOTE_SHA" 2>/dev/null; then
  if git diff --name-only "$REMOTE_SHA" "$LOCAL_SHA" | grep -qE '^aws/(template\.yaml|deploy\.sh)$'; then
    infra_changed=1
  fi
fi
echo "• production deploy"
trap 'echo "✗ deploy failed — production may be PARTIALLY updated (see phase above); push aborted. Fix and re-run: npm run deploy" >&2' ERR
bash aws/deploy-web.sh
echo "✓ pre-push gate + deploy complete"
if [ -n "$infra_changed" ]; then
  echo "⚠ aws/template.yaml or aws/deploy.sh changed — Lambda INFRA is NOT auto-deployed by this hook."
  echo "  Apply infra manually with admin creds:  npm run deploy:aws   (full SAM)"
fi
