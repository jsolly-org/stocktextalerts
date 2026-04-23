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
# Prepend repo node_modules/.bin so SAM's native esbuild integration finds
# the pinned esbuild binary (not whatever is globally installed).
PATH="$REPO_ROOT/node_modules/.bin:$PATH" sam build
sam deploy --parameter-overrides "${SAM_PARAMS[@]}"
