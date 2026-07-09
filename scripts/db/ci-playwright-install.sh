#!/usr/bin/env bash
# Install Playwright chromium-headless-shell for CI.
# OS deps (apt) run once per sticky-disk mount via a marker file so warm runs
# skip the multi-minute apt round-trip. See .github/workflows/ci.yml.
#
# Usage: bash scripts/db/ci-playwright-install.sh
# Writes exit status to /tmp/playwright-install.rc (for the wait step).
set -uo pipefail

rc_file="${PLAYWRIGHT_INSTALL_RC_FILE:-/tmp/playwright-install.rc}"
deps_marker="${HOME}/.cache/ms-playwright/.ci-deps-installed"

write_rc() {
	echo "$1" >"$rc_file"
}

npx playwright install --only-shell
rc=$?
if [ "$rc" -ne 0 ]; then
	write_rc "$rc"
	exit "$rc"
fi

if [[ ! -f "$deps_marker" ]]; then
	echo "No OS-deps marker on sticky disk — running playwright install-deps once"
	npx playwright install-deps
	rc=$?
	if [ "$rc" -eq 0 ]; then
		touch "$deps_marker"
	fi
else
	echo "OS-deps marker present — skipping install-deps"
fi

write_rc "$rc"
exit "$rc"
