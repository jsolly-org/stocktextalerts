#!/usr/bin/env bash
# Ground shellcheck (via dotagents gate-lib), then run actionlint on workflow YAML.
#
# github-actionlint only applies shellcheck rules when `shellcheck` is on PATH.
# Without this guard, a laptop missing shellcheck silently skips SC* findings
# that CI still enforces. Shared primitive: gate_require_shellcheck in
# ~/code/dotagents/gate/gate-lib.sh (rules/tool-versions.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=/dev/null
source "${DOTAGENTS_GATE_LIB:-$HOME/code/dotagents/gate/gate-lib.sh}" || {
	echo "✗ dotagents gate-lib not found — re-run install-local-agent-runtime.sh." >&2
	exit 1
}

gate_require_shellcheck
exec ./node_modules/.bin/github-actionlint .github/workflows/*.yml
