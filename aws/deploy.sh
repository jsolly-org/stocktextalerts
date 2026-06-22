#!/usr/bin/env bash
# Deploy the SAM stack using values from ../.env.local. Run via:
#   cd aws && ./deploy.sh
# or from repo root:
#   npm run deploy:aws
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./sam-params.sh
source "$SCRIPT_DIR/sam-params.sh"

cd "$SCRIPT_DIR"
# Resolve sam to the repo-pinned version (.mise.toml) — mise walks up to the repo root for it.
# Guarded so a machine without mise degrades to the global sam (rules/tool-versions.md).
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)"
# Ground the SAM CLI: not an npm dep — fail loud if absent (rules/dependency-grounding.md).
command -v sam >/dev/null 2>&1 || { echo "✗ sam CLI not found — brew install aws-sam-cli" >&2; exit 1; }
# The post-deploy provenance tagging below shells out to aws (also a system CLI, not an npm dep).
command -v aws >/dev/null 2>&1 || { echo "✗ aws CLI not found — brew install awscli" >&2; exit 1; }
# Reproducible bundle: reinstall exactly the committed lockfile before `sam build`
# bundles the Lambda from gitignored node_modules. This MANUAL path runs from a
# possibly-stale checkout — the read-only `main` mirror is never `npm ci`'d in the
# worktree-first flow — so always reinstall (the 2026-06-21 incident was a week-stale
# node_modules here, missing a newly-added dep esbuild then couldn't resolve).
( cd "$REPO_ROOT" && npm ci )
# Prepend repo node_modules/.bin so SAM's native esbuild integration finds
# the pinned esbuild binary (not whatever is globally installed).
PATH="$REPO_ROOT/node_modules/.bin:$PATH" sam build
sam deploy --parameter-overrides "${SAM_PARAMS[@]}"

# Re-stamp Deploy-Sha256/Deploy-Commit on every function. A full SAM deploy rebuilds the bundle
# (→ a new CodeSha256) through CloudFormation but does NOT run deploy-web.sh's per-function tag
# step, so without this the provenance tags desync from live code and scripts/check-deploy-drift.ts
# false-fires its INTEGRITY check on this legitimate, on-pipeline deploy. Same two tags the
# code-only deploy writes; reads each function's post-deploy CodeSha256 from list-functions (no
# hardcoded function list to drift from the template). Fail-closed: set -e + gate_lambda_tag_provenance
# abort if tagging can't complete (a stale tag would make the audit lie).
# shellcheck source=/dev/null
source "${DOTAGENTS_GATE_LIB:-$HOME/code/dotagents/gate/gate-lib.sh}" || {
  echo "✗ dotagents gate-lib not found (expected ~/code/dotagents/gate/gate-lib.sh) — re-run install-local-agent-runtime.sh." >&2
  exit 1
}
_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
_fns="$(aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName, 'stocktextalerts-')].[FunctionName, CodeSha256, FunctionArn]" \
  --output text)"
[ -n "$_fns" ] || { echo "✗ no stocktextalerts-* functions found to tag after deploy" >&2; exit 1; }
echo "• stamp deploy provenance tags (Deploy-Sha256 / Deploy-Commit)"
while read -r _name _sha _arn; do
  [ -n "$_name" ] || continue
  gate_lambda_tag_provenance "$_arn" "$_sha" "$_commit"
  echo "  ✓ $_name ($_sha)"
done <<<"$_fns"
