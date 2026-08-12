#!/usr/bin/env bash
# Lint GitHub Actions workflows with actionlint + shellcheck.
#
# Both tools are lockfile-pinned npm deps (node_modules/.bin). CI and local
# gates share the same binaries — no mise/brew/PATH dependence, no sourcing
# ~/code/dotagents (gate-lib is for local hooks only; scripts CI runs must be
# repo-self-contained — see rules/dependency-grounding.md).
#
# The `shellcheck` npm package lazily downloads the official koalaman binary
# on first invoke; warm it here so actionlint's -shellcheck path is a real
# executable before the lint runs.
#
# Copy into each workflow repo as scripts/check-actions.sh, then:
#   "check:actions": "bash scripts/check-actions.sh"
# in package.json, plus `run_step "actionlint" npm run check:actions` in
# .git-hooks/pre-commit and `- run: npm run check:actions` in ci.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ACTIONLINT="$ROOT/node_modules/.bin/github-actionlint"
SHELLCHECK="$ROOT/node_modules/.bin/shellcheck"

if [[ ! -x "$ACTIONLINT" ]]; then
	echo "✗ github-actionlint not found at $ACTIONLINT — run npm ci" >&2
	exit 1
fi
if [[ ! -x "$SHELLCHECK" ]]; then
	echo "✗ shellcheck not found at $SHELLCHECK — run npm ci" >&2
	exit 1
fi

# Warm the lazy-downloaded binary (prints version; fails loud on network/arch miss).
# First invoke may download from GitHub; retry transient socket/TLS failures.
warm_ok=0
for attempt in 1 2 3 4 5; do
	if "$SHELLCHECK" --version >/dev/null 2>/tmp/shellcheck-warm.err; then
		warm_ok=1
		break
	fi
	echo "shellcheck warm attempt ${attempt} failed; retrying…" >&2
	cat /tmp/shellcheck-warm.err >&2 || true
	sleep $((attempt * 2))
done
if [[ "$warm_ok" -ne 1 ]]; then
	echo "✗ shellcheck failed to download/run after retries" >&2
	exit 1
fi

exec "$ACTIONLINT" -shellcheck "$SHELLCHECK" .github/workflows/*.yml
