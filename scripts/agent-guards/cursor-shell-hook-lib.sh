#!/usr/bin/env bash
# Shared helpers for Cursor beforeShellExecution and Claude PreToolUse guard scripts.
# Source from scripts in this directory; do not execute directly.

HOOK_INPUT=""
HOOK_CMD=""

cursor_read_hook_input() {
	HOOK_INPUT=""
	if IFS= read -r -t 1 first_line || [[ -n "${first_line:-}" ]]; then
		HOOK_INPUT=$first_line
		while IFS= read -r -t 0.05 next_line; do
			HOOK_INPUT="${HOOK_INPUT}
${next_line}"
		done
	fi
	HOOK_CMD=$(
		printf '%s' "$HOOK_INPUT" | jq -r '.command // .tool_input.command // empty' 2>/dev/null || true
	)
}

cursor_is_cursor_hook() {
	printf '%s' "$HOOK_INPUT" | jq -e '.command' >/dev/null 2>&1
}

cursor_allow() {
	if [[ -z "$HOOK_INPUT" ]] || cursor_is_cursor_hook; then
		echo '{"permission":"allow"}'
	fi
	exit 0
}

cursor_deny() {
	local msg="$1"
	if cursor_is_cursor_hook; then
		jq -n --arg um "$msg" --arg am "$msg" '{
			permission: "deny",
			user_message: $um,
			agent_message: $am
		}'
		exit 0
	fi
	claude_deny "$msg"
}

claude_deny() {
	local msg="$1"
	jq -n --arg reason "$msg" '{
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: $reason
		}
	}'
	exit 2
}

# True when the shell command is running a hook script (avoid nested beforeShellExecution).
is_hook_runner_command() {
	local cmd="$1"
	[[ -n "$cmd" ]] || return 1
	printf '%s' "$cmd" | grep -qE '(block-git-no-verify|wrap-block-git-no-verify|block-prod-db-migrations|cursor-shell-hook|\.agents/hooks/)'
}
