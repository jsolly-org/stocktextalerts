#!/usr/bin/env bash
# Deploy the SAM stack using values from ../.env.local. Run via:
#   cd aws && ./deploy.sh
# or from repo root:
#   npm run deploy:infra
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
# Reproducible bundle: reinstall exactly the committed lockfile before `sam build`
# bundles the Lambda from gitignored node_modules. This MANUAL path runs from a
# possibly-stale checkout — the read-only `main` mirror is never `npm ci`'d in the
# worktree-first flow — so always reinstall (the 2026-06-21 incident was a week-stale
# node_modules here, missing a newly-added dep esbuild then couldn't resolve).
( cd "$REPO_ROOT" && npm ci )
# Prepend repo node_modules/.bin so SAM's native esbuild integration finds
# the pinned esbuild binary (not whatever is globally installed).
PATH="$REPO_ROOT/node_modules/.bin:$PATH" sam build

# Chart render assets (resvg wasm + Roboto TTFs) must ride EVERY deploy path that packages
# .aws-sam/build — without this, a full SAM deploy ships asset-less bundles and every Telegram
# chart silently degrades to text-only (and the live-provider-check chart:render-png step pages
# red on its next run). Shared helper with deploy-web.sh's build_lambdas.
# shellcheck source=./chart-assets.sh
source "$SCRIPT_DIR/chart-assets.sh"
copy_chart_assets "$REPO_ROOT"

# Deploy-after-landing: a full SAM deploy ships Lambda code, so deploy ONLY what has landed on
# origin/main — never the local tree before the ref lands (the same invariant the code-only
# deploy:code path enforces; rules/agent-cloud-access.md, docs/plans/2026-06-24-deploy-after-landing.md).
# gate-lib is sourced here for the landing guard below. Runs after the reversible
# npm ci + sam build, before the irreversible sam deploy.
# shellcheck source=/dev/null
source "${DOTAGENTS_GATE_LIB:-$HOME/code/dotagents/gate/gate-lib.sh}" || {
  echo "✗ dotagents gate-lib not found (expected ~/code/dotagents/gate/gate-lib.sh) — re-run install-local-agent-runtime.sh." >&2
  exit 1
}
gate_require_landed main

sam deploy --parameter-overrides "${SAM_PARAMS[@]}"
