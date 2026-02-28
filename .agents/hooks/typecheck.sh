#!/bin/bash
# Hook: Run tsc --noEmit to catch type errors after Claude finishes a task.
# Exit 0 = no errors, proceed. Exit 2 = errors found, feed back to Claude.

cd "$CLAUDE_PROJECT_DIR" || exit 0

OUTPUT=$(npx tsc --noEmit 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "TypeScript type-check failed. Please fix these errors:" >&2
  echo "" >&2
  echo "$OUTPUT" >&2
  exit 2
fi

exit 0
