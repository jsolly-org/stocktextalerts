#!/usr/bin/env bash
# verify-local-supabase.sh — end-to-end smoke check for the local Supabase
# bootstrap. Run this after machine reinstalls, Podman/Supabase CLI upgrades,
# or any change that touches `supabase/config.toml`, `scripts/db/generate-seed.ts`,
# `scripts/db/doctor.ts`, or the `db:*` scripts in `package.json`.
#
# It's a local-only helper. This script exists
# so that regressions in the full local flow show up locally before someone
# hits them on a fresh clone.
#
# Usage:
#   scripts/ci/verify-local-supabase.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Bootstrapping local Supabase (npm run db:bootstrap)"
# db:bootstrap already ends with db:doctor, so a successful run implies a
# healthy stack. No need to re-run db:doctor here.
npm run db:bootstrap

echo "✅ Local Supabase bootstrap verified."
