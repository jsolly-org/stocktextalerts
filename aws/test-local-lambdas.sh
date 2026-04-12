#!/bin/bash
# Build and invoke all Lambda handlers locally via sam local invoke.
# Catches packaging/env-var/init errors that unit tests miss.
# Requires a container runtime (Podman or Docker) reachable via
# DOCKER_HOST. See AGENTS.md#local-container-runtime-podman.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

echo "=== Building Lambda bundles ==="
cd "$REPO_ROOT"
npx tsx aws/esbuild.config.ts

echo ""
echo "=== Generating env.json ==="
bash "$SCRIPT_DIR/generate-env-json.sh"

cd "$SCRIPT_DIR"

FUNCTIONS=(ScheduleFunction AssetEventsFunction ComputeDailyStatsFunction)
EVENT='{"source":"aws.scheduler"}'
FAILED=()

for fn in "${FUNCTIONS[@]}"; do
  echo ""
  echo "=== Invoking $fn ==="
  if echo "$EVENT" | sam local invoke "$fn" --env-vars env.json --event - 2>&1; then
    echo "✓ $fn succeeded"
  else
    echo "✗ $fn FAILED"
    FAILED+=("$fn")
  fi
done

echo ""
echo "=== Results ==="
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✓ All ${#FUNCTIONS[@]} functions passed"
else
  echo "✗ ${#FAILED[@]} function(s) failed: ${FAILED[*]}"
  exit 1
fi
