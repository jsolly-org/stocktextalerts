#!/usr/bin/env bash
# Chart render assets, shared by BOTH Lambda deploy paths:
#   - aws/deploy-web.sh build_lambdas (code deploys: pre-push --build gate, CI --deploy-ci, local break-glass)
#   - aws/deploy.sh (full SAM infra deploy — sam deploy packages the same .aws-sam/build dirs)
# candlestick.ts rasterizes via @resvg/resvg-wasm, whose .wasm binary and Roboto font buffers are
# read from the bundle root at runtime (LAMBDA_TASK_ROOT — the wasm build loads no system fonts,
# and Lambda has none). esbuild bundles only JS, so these files must be copied into every function
# build dir after `sam build`; both zips (deploy_code) and `sam deploy` packaging pick up dir
# contents verbatim. Copying to ALL functions mirrors the "every function ships every push"
# invariant and stays robust to import-graph changes (~2.7 MB per bundle).
#
# INVARIANT: the basenames here must match the keys candlestick.ts reads from the bundle root
# (src/lib/messaging/parts/charts/candlestick.ts readChartAsset). A mismatch ships text-only
# charts — caught post-deploy by the live-provider-check chart:render-png step, but keep them
# in sync at edit time.
#
# Every failure is loud (explicit `|| return 1` — callers invoke this in a `||` context, which
# suspends errexit inside the function body, so a bare failing `cp` would otherwise be silently
# swallowed and the build would report success with asset-less bundles).

copy_chart_assets() { # <repo-root>
  local root="$1"
  local assets=(
    "$root/node_modules/@resvg/resvg-wasm/index_bg.wasm"
    "$root/node_modules/@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf"
    "$root/node_modules/@expo-google-fonts/roboto/500Medium/Roboto_500Medium.ttf"
  )
  local asset fn_dir copied=0
  for asset in "${assets[@]}"; do
    [ -f "$asset" ] || { echo "✗ chart asset missing: $asset (run npm ci)" >&2; return 1; }
  done
  for fn_dir in "$root"/aws/.aws-sam/build/*/; do
    [ -d "$fn_dir" ] || continue
    cp "${assets[@]}" "$fn_dir" || { echo "✗ failed to copy chart assets into $fn_dir" >&2; return 1; }
    copied=$((copied + 1))
  done
  [ "$copied" -gt 0 ] || { echo "✗ no function build dirs under aws/.aws-sam/build — chart assets not shipped" >&2; return 1; }
  echo "  ✓ chart render assets copied into $copied function bundles"
}
