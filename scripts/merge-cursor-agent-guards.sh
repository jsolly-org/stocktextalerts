#!/usr/bin/env bash
# Idempotently merge repo agent guards into .cursor/hooks.json (matchers + wrapper).
# Run after fleet sync if merge-cursor-git-guard.sh re-adds a no-matcher git guard entry.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

HOOKS=".cursor/hooks.json"
mkdir -p .cursor

GIT_WRAPPER="bash scripts/agent-guards/wrap-block-git-no-verify.sh"
PROD_GUARD="bash scripts/agent-guards/block-prod-db-migrations.sh"
GIT_MATCHER='git +(push|commit)'
PROD_MATCHER='supabase|psql|DATABASE_URL_PROD|SUPABASE_URL_PROD|SUPABASE_SECRET_KEY_PROD|japesagairjvvuebzpvr'

merge_hooks() {
	jq \
		--arg git_cmd "$GIT_WRAPPER" \
		--arg prod_cmd "$PROD_GUARD" \
		--arg git_matcher "$GIT_MATCHER" \
		--arg prod_matcher "$PROD_MATCHER" '
		.version //= 1
		| .hooks.beforeShellExecution //= []
		| .hooks.beforeShellExecution |= map(
			if ((.command // "") | test("block-git-no-verify|wrap-block-git-no-verify")) then
				{
					command: $git_cmd,
					matcher: $git_matcher,
					failClosed: true,
					timeout: 10
				}
			elif ((.command // "") | test("block-prod-db-migrations")) then
				{
					command: $prod_cmd,
					matcher: $prod_matcher,
					failClosed: true,
					timeout: 10
				}
			else .
			end
		)
		| if (.hooks.beforeShellExecution | map(.command // "") | any(test("wrap-block-git-no-verify"))) then .
			else .hooks.beforeShellExecution += [{
				command: $git_cmd,
				matcher: $git_matcher,
				failClosed: true,
				timeout: 10
			}]
			end
		| if (.hooks.beforeShellExecution | map(.command // "") | any(test("block-prod-db-migrations"))) then .
			else .hooks.beforeShellExecution += [{
				command: $prod_cmd,
				matcher: $prod_matcher,
				failClosed: true,
				timeout: 10
			}]
			end
	'
}

if [[ -f "$HOOKS" ]]; then
	merge_hooks <"$HOOKS" >"$HOOKS.new"
else
	merge_hooks <<<'{"version":1,"hooks":{}}' >"$HOOKS.new"
fi
mv "$HOOKS.new" "$HOOKS"
echo "Merged agent guards into $HOOKS"
