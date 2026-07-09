#!/usr/bin/env bash
# Ground shellcheck, then run actionlint on workflow YAML.
#
# github-actionlint only applies shellcheck rules when `shellcheck` is on PATH.
# Without this guard, a laptop missing shellcheck silently skips SC* findings
# that CI (Blacksmith images ship shellcheck) still enforces — the exact gap
# that let SC2016 land on #581.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Resolve the repo-pinned shellcheck from .mise.toml (non-interactive hooks
# don't load the shell profile's mise activation). Guarded so a machine without
# mise still works if shellcheck is already on PATH (brew / CI image).
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)"

# Presence floor — fail loud; do not let actionlint degrade to "no shellcheck".
command -v shellcheck >/dev/null 2>&1 || {
	echo "✗ shellcheck not found on PATH." >&2
	echo "  Pin is in .mise.toml — run: mise install" >&2
	echo "  (or: brew install shellcheck). Required so actionlint applies SC* rules." >&2
	exit 1
}

exec ./node_modules/.bin/github-actionlint .github/workflows/*.yml
