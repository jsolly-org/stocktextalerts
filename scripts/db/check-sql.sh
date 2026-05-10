#!/usr/bin/env bash
# Lint Postgres migrations with squawk.
#
# Skips the pg_dump-style squashed baseline (squawk's parser can't handle the
# IDENTITY column / SEQUENCE NAME syntax pg_dump emits).
#
# - With no args: lints all files under supabase/migrations/ except the baseline.
# - With args (used by lint-staged): lints those files except the baseline.
# - Exits 0 when there is nothing left to lint.
set -euo pipefail

SQUASHED_BASELINE="supabase/migrations/20260509161208_migrate_market_times_to_et.sql"
SQUAWK="./node_modules/.bin/squawk"

input=()
if [ "$#" -gt 0 ]; then
  input=("$@")
else
  shopt -s nullglob
  for f in supabase/migrations/*.sql; do input+=("$f"); done
  shopt -u nullglob
fi

files=()
for f in "${input[@]}"; do
  rel="${f#./}"
  rel="${rel#"$PWD/"}"
  if [ "$rel" = "$SQUASHED_BASELINE" ]; then
    continue
  fi
  files+=("$f")
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-sql: no migrations to lint (baseline only)."
  exit 0
fi

exec "$SQUAWK" "${files[@]}"
