#!/usr/bin/env bash
# Block agent shell commands that apply or repair production Supabase migrations,
# or connect to production Postgres. Used by Cursor and Claude Code hooks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./cursor-shell-hook-lib.sh
source "$SCRIPT_DIR/cursor-shell-hook-lib.sh"

cursor_read_hook_input

if is_hook_runner_command "$HOOK_CMD"; then
	cursor_allow
fi

[[ -n "$HOOK_CMD" ]] || cursor_allow

block_msg='Production Supabase changes are CI-only. Create migration files locally, commit, and let GitHub Actions run supabase db push. Do not use db push, migration repair, psql against prod, or Supabase MCP apply_migration/execute_sql.'

PROD_MARKERS='DATABASE_URL_PROD|SUPABASE_URL_PROD|SUPABASE_SECRET_KEY_PROD|japesagairjvvuebzpvr'

strip_quoted() {
	printf '%s' "$1" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g"
}

segment_has_supabase_db_push() {
	local stripped="$1"
	printf '%s' "$stripped" | grep -qiE 'supabase[[:space:]]+db[[:space:]]+push'
}

segment_has_supabase_migration_repair() {
	local stripped="$1"
	printf '%s' "$stripped" | grep -qiE 'supabase[[:space:]]+migration[[:space:]]+repair'
}

segment_has_psql() {
	local stripped="$1"
	printf '%s' "$stripped" | grep -qE '(^|[[:space:]])(/[^[:space:]]+/)?psql([[:space:]]|$)'
}

segment_has_prod_markers() {
	local stripped="$1"
	printf '%s' "$stripped" | grep -qiE "$PROD_MARKERS"
}

segment_is_blocked() {
	local segment="$1"
	local stripped
	local check
	stripped=$(strip_quoted "$segment")
	for check in "$segment" "$stripped"; do
		segment_has_supabase_db_push "$check" && return 0
		segment_has_supabase_migration_repair "$check" && return 0
		segment_has_psql "$check" && return 0
		segment_has_prod_markers "$check" && return 0
	done
	return 1
}

split_segments() {
	printf '%s' "$1" | tr '&|;' '\n' | sed 's/&&/\n/g' | sed 's/||/\n/g'
}

should_block=false
while IFS= read -r segment || [[ -n "${segment:-}" ]]; do
	segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
	[[ -z "$segment" ]] && continue
	if segment_is_blocked "$segment"; then
		should_block=true
		break
	fi
done < <(split_segments "$HOOK_CMD")

if ! $should_block; then
	cursor_allow
fi

cursor_deny "$block_msg"
