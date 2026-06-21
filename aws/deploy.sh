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
