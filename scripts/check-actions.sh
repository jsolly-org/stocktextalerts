#!/usr/bin/env bash
# Ground shellcheck, then run actionlint on workflow YAML.
#
# github-actionlint only applies shellcheck rules when `shellcheck` is on PATH.
# Without this guard, a machine missing shellcheck silently skips SC* findings
# that CI still enforces (the gap that let SC2016 land on #581).
#
# Prefer the shared fleet primitive gate_require_shellcheck
# (~/code/dotagents/gate/gate-lib.sh, rules/tool-versions.md) so the guard can't
# drift from the fleet template. That checkout only exists on developer machines,
# so fall back to a self-contained presence floor everywhere it is absent
# (GitHub CI, contributors without dotagents) instead of hard-failing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Resolve the repo-pinned shellcheck from .mise.toml (non-interactive hooks
# don't load the shell profile's mise activation). Guarded so a machine without
# mise still works if shellcheck is already on PATH (brew / CI image).
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)"

gate_lib="${DOTAGENTS_GATE_LIB:-$HOME/code/dotagents/gate/gate-lib.sh}"
if [ -f "$gate_lib" ]; then
	# shellcheck source=/dev/null
	source "$gate_lib"
	gate_require_shellcheck
else
	# Self-contained presence floor: fail loud, do not let actionlint degrade
	# to "no shellcheck" and silently skip SC* rules.
	command -v shellcheck >/dev/null 2>&1 || {
		echo "✗ shellcheck not found on PATH." >&2
		echo "  Pin is in .mise.toml; run: mise install (or: brew install shellcheck)." >&2
		echo "  Required so actionlint applies SC* rules." >&2
		exit 1
	}
fi

exec ./node_modules/.bin/github-actionlint .github/workflows/*.yml
