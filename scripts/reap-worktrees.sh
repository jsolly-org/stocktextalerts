#!/usr/bin/env bash
# Reap merged + clean linked worktrees. Wired non-fatally into .git-hooks/pre-push.
#
# Why this exists: stocktextalerts ships via github-handoff — `/ship` opens a PR and
# stops; auto-merge lands it asynchronously AFTER the session ends. So `/ship` step 15's
# worktree cleanup (gated on "merge landed on origin/main") can never fire in-session,
# and nothing else reaps the leftover checkout. This sweeps them on the next push instead.
#
# A worktree is reaped ONLY when BOTH hold:
#   1. clean working tree (git status --porcelain empty) — protects uncommitted work even
#      when the branch tip already matches main (a worktree at main's SHA can still hold a
#      whole uncommitted refactor; never eat it). A status that ERRORS counts as not-clean.
#   2. merged — proven, never inferred from "branch config exists" or "remote branch gone"
#      (both fire on never-pushed branches and abandoned PRs). EITHER:
#        a. HEAD is an ancestor of origin/main (fast-forward / rebase merge / a branch
#           sitting at main with no new commits) — git-only, certain; OR
#        b. its branch tracks an origin branch whose PR actually MERGED, confirmed via
#           `gh pr --state merged --head <tracked-name>`. A squash merge un-ancestors the
#           tip, and the local worktree branch name often differs from the pushed/PR name,
#           so we resolve the *tracked upstream* branch name (not the local name) and ask
#           GitHub. A branch freshly created off origin/main tracks `main` itself (no push
#           yet) — never a feature PR head, so it's correctly rejected.
#
# Skips the current, primary, and detached-HEAD worktrees. Non-fatal throughout so it can
# never block a push. Remote/gh unreachable → reap nothing (fail safe). Known residual edge:
# committing MORE work on a clean branch AFTER its PR merged, without pushing, then reaping
# it loses those local-only commits (reflog recovers for git's GC window) — exotic enough to
# accept over leaving every squash-merged worktree to pile up.
#
# (Kept as a script, not an inline npm-script snippet, so knip doesn't parse the shell
# builtins as unlisted binaries — mirrors copy-worktree-includes.sh.)
set -u

# Canonicalize (pwd -P) so the current/primary self-protection is a path-identity compare,
# not a brittle string compare that a symlinked path component could slip past.
current="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
current="$(cd "$current" 2>/dev/null && pwd -P)" || exit 0
primary="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
primary="$(cd "$primary" 2>/dev/null && pwd -P)" || primary=""

# Refresh origin/main so the ancestor check below sees a current base. Non-fatal:
# offline leaves it stale, which only makes us reap LESS.
git fetch --quiet origin main 2>/dev/null || true
base="$(git rev-parse --verify --quiet origin/main)" || base=""

reap_one() {
	local path="$1" sha="$2" ref="$3"
	[ -n "$path" ] || return 0
	[ -n "$ref" ] || return 0   # detached HEAD — can't reason about a branch
	local rp; rp="$(cd "$path" 2>/dev/null && pwd -P)" || return 0
	[ "$rp" != "$primary" ] || return 0   # never the primary checkout
	[ "$rp" != "$current" ] || return 0   # never the worktree we're pushing from
	local name="${ref#refs/heads/}"

	# 1. Clean tree — the load-bearing guard. A status that errors (locked index, broken
	#    gitdir) must NOT read as clean, so bail on any non-zero exit, not just on output.
	local st; st="$(git -C "$path" status --porcelain 2>/dev/null)" || return 0
	[ -z "$st" ] || return 0

	# 2. Merged? (see header — proven, never inferred)
	local merged=0
	if [ -n "$base" ] && git merge-base --is-ancestor "$sha" "$base" 2>/dev/null; then
		merged=1
	else
		local up; up="$(git config --get "branch.$name.merge" 2>/dev/null)" || up=""
		local rb="${up#refs/heads/}"
		# Tracks an origin branch that isn't main/master, and gh confirms its PR merged.
		if [ -n "$rb" ] && [ "$rb" != main ] && [ "$rb" != master ] \
			&& [ "$(git config --get "branch.$name.remote" 2>/dev/null)" = origin ] \
			&& command -v gh >/dev/null 2>&1 \
			&& [ -n "$(gh pr list --state merged --head "$rb" --limit 1 --json number --jq '.[0].number' 2>/dev/null)" ]; then
			merged=1
		fi
	fi
	[ "$merged" -eq 1 ] || return 0

	if git worktree remove "$path" 2>/dev/null; then
		# merge is proven above, so a -d refusal just means a squash-merge (the branch tip is
		# never an ancestor of main); force-drop the now-orphaned local branch.
		git branch -d "$name" 2>/dev/null || git branch -D "$name" 2>/dev/null || true
		rmdir "$(dirname "$path")" 2>/dev/null || true   # prune the now-empty parent dir
		echo "• reaped worktree $name ($path)"
	fi
}

# git worktree list --porcelain emits blank-line-separated records:
#   worktree <path> / HEAD <sha> / branch refs/heads/<name>  (or a bare `detached`).
wt=""; head=""; branch=""
while IFS= read -r line; do
	case "$line" in
		"worktree "*) wt="${line#worktree }" ;;
		"HEAD "*)     head="${line#HEAD }" ;;
		"branch "*)   branch="${line#branch }" ;;
		detached)     branch="" ;;
		"")           reap_one "$wt" "$head" "$branch"; wt=""; head=""; branch="" ;;
	esac
done < <(git worktree list --porcelain)
reap_one "$wt" "$head" "$branch"   # defensive: reap the final record if git emits no trailing blank line

git worktree prune 2>/dev/null || true
