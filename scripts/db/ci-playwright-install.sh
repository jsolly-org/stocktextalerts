#!/usr/bin/env bash
# Install Playwright chromium-headless-shell for CI.
# Browser binaries live on the Blacksmith sticky disk (~/.cache/ms-playwright).
# OS deps (apt) are installed on the *runner* filesystem, not the sticky disk —
# so a marker on the sticky disk is wrong: a warm mount on a fresh runner skips
# apt and E2E dies with missing libs (e.g. libatk-1.0.so.0). Marker is therefore
# per-runner under /tmp. See .github/workflows/ci.yml + docs/github-ci.md.
#
# Usage: bash scripts/db/ci-playwright-install.sh
# Writes exit status to /tmp/playwright-install.rc (for the wait step).
set -uo pipefail

rc_file="${PLAYWRIGHT_INSTALL_RC_FILE:-/tmp/playwright-install.rc}"
# Runner-local: apt packages don't ride the sticky disk across hosts.
deps_marker="${PLAYWRIGHT_DEPS_MARKER:-/tmp/playwright-ci-deps-installed}"

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
	echo "No OS-deps marker on this runner — running playwright install-deps chromium"
	npx playwright install-deps chromium
	rc=$?
	if [ "$rc" -eq 0 ]; then
		touch "$deps_marker"
	fi
else
	echo "OS-deps marker present on this runner — skipping install-deps"
fi

write_rc "$rc"
exit "$rc"
