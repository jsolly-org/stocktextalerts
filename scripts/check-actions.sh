#!/usr/bin/env bash
# Lint GitHub Actions workflows with actionlint + shellcheck.
#
# Both tools are lockfile-pinned npm deps (node_modules/.bin). CI and local
# gates share the same binaries — no mise/brew/PATH dependence, no sourcing
# ~/code/dotagents (gate-lib is for local hooks only; scripts CI runs must be
# repo-self-contained).
#
# The `shellcheck` npm package lazily downloads the official koalaman binary
# on first invoke; warm it here so actionlint's -shellcheck path is a real
# executable before the lint runs.
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
"$SHELLCHECK" --version >/dev/null

exec "$ACTIONLINT" -shellcheck "$SHELLCHECK" .github/workflows/*.yml
