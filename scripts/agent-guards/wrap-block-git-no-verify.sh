#!/usr/bin/env bash
# Cursor wrapper: narrow surface + skip hook-runner commands, then delegate to fleet guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./cursor-shell-hook-lib.sh
source "$SCRIPT_DIR/cursor-shell-hook-lib.sh"

ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FLEET_GUARD="$ROOT/.agents/hooks/block-git-no-verify.sh"

cursor_read_hook_input

if is_hook_runner_command "$HOOK_CMD"; then
	cursor_allow
fi

if [[ -z "$HOOK_CMD" ]] || ! printf '%s' "$HOOK_CMD" | grep -qE '(^|[[:space:];&|])(/[^[:space:]]+/)?git[[:space:]]+(push|commit)([[:space:]]|$)'; then
	cursor_allow
fi

[[ -f "$FLEET_GUARD" ]] || {
	echo "Missing fleet guard: $FLEET_GUARD" >&2
	exit 1
}

printf '%s' "$HOOK_INPUT" | bash "$FLEET_GUARD"
