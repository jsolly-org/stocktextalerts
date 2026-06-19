#!/usr/bin/env bash
# Copy the repo's .worktreeinclude allowlist of gitignored files from the primary
# worktree into the current worktree. Mirrors dotagents' WorktreeCreate hook
# provision_worktree() for the manual `git worktree add` path, which bypasses the
# Claude-only hook. Copy, never symlink — a symlinked .env.local trips Vite's
# server.fs.allow. Invoked non-fatally from package.json `worktree:init`
# (`... || true`) so a copy failure can't abort the npm ci that follows.
#
# (Kept as a script, not an inline npm-script snippet, because knip parses script
# strings and flags the `read`/`continue` shell builtins as unlisted binaries.)
set -u

primary="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
[ -n "$primary" ] || exit 0
# Nothing to do in the primary checkout itself.
[ "$primary" != "$PWD" ] || exit 0
[ -f .worktreeinclude ] || exit 0

while IFS= read -r line || [ -n "$line" ]; do
	line="${line%%#*}"                          # strip trailing/inline comments
	line="$(printf '%s' "$line" | tr -d '[:space:]')"
	[ -n "$line" ] || continue                  # skip blanks / comment-only lines
	for src in "$primary"/$line; do             # glob-expand against the primary
		[ -e "$src" ] || continue               # tolerate zero matches
		rel="${src#"$primary"/}"
		mkdir -p "$(dirname "$rel")"
		cp -R "$src" "$rel"
	done
done < .worktreeinclude
