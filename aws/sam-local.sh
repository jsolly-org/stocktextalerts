#!/usr/bin/env bash
# Build the Lambda bundles and invoke each handler locally with
# `sam local invoke`. Passes ../.env.local values through as SAM parameter
# overrides so the same env plumbing is used as in prod deploys.
#
# Usage:
#   ./sam-local.sh                       # invoke all three functions
#   ./sam-local.sh ScheduleFunction      # invoke one function
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./sam-params.sh
source "$SCRIPT_DIR/sam-params.sh"

cd "$SCRIPT_DIR"
PATH="$REPO_ROOT/node_modules/.bin:$PATH" sam build

if [ $# -gt 0 ]; then
  FUNCTIONS=("$@")
else
  FUNCTIONS=(ScheduleFunction AssetEventsFunction ComputeDailyStatsFunction)
fi

EVENT='{"source":"aws.scheduler"}'
FAILED=()

for fn in "${FUNCTIONS[@]}"; do
  echo ""
  echo "=== Invoking $fn ==="
  if echo "$EVENT" | sam local invoke "$fn" \
    --parameter-overrides "${SAM_PARAMS[@]}" \
    --event -; then
    echo "✓ $fn succeeded"
  else
    echo "✗ $fn FAILED"
    FAILED+=("$fn")
  fi
done

echo ""
echo "=== Results ==="
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✓ All ${#FUNCTIONS[@]} function(s) passed"
else
  echo "✗ ${#FAILED[@]} function(s) failed: ${FAILED[*]}"
  exit 1
fi
