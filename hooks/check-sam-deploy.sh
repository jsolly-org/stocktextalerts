#!/bin/bash
# Checks if staged files require a SAM deploy after commit.
# Works with both Claude Code (PreToolUse) and Cursor (beforeShellExecution).
#
# Claude Code: called via .claude/settings.json PreToolUse hook with `if: Bash(git commit:*)`
# Cursor: called via .cursor/hooks.json beforeShellExecution with `matcher: "git commit"`
#
# Cursor sends {"command":"..."} on stdin; Claude Code uses the `if` filter instead.
# We detect the caller by checking stdin for a JSON command field.

input=$(cat 2>/dev/null)
cmd=$(echo "$input" | jq -r '.command // empty' 2>/dev/null)

# Cursor path: check if the command is a git commit
if [ -n "$cmd" ]; then
  if ! echo "$cmd" | grep -qE '^git commit'; then
    echo '{"permission": "allow"}'
    exit 0
  fi
fi

# Shared logic: check staged files
staged=$(git diff --cached --name-only 2>/dev/null)
matched=$(echo "$staged" | grep -E '^(aws/template\.yaml|aws/deploy\.sh|aws/src/handlers/|src/lib/)' 2>/dev/null)

if [ -z "$matched" ]; then
  # No Lambda files staged
  if [ -n "$cmd" ]; then
    echo '{"permission": "allow"}'
  fi
  exit 0
fi

warning="SAM deploy required after this commit (cd aws && npm run deploy). Staged Lambda-related files: $(echo "$matched" | tr '\n' ' ' | sed 's/  */ /g' | xargs)"

if [ -n "$cmd" ]; then
  # Cursor format - build JSON safely so newlines in $matched don't break parsing
  jq -n \
    --arg permission "ask" \
    --arg msg "$warning" \
    '{permission: $permission, user_message: $msg, agent_message: $msg}'
else
  # Claude Code format
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"WARNING: %s"}}' "$warning"
fi
