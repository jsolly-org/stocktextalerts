#!/usr/bin/env bash
# App-local Playwright install hardening for Cursor Cloud.
# Source from scripts/cloud-agent-install.sh after cloud-install-supabase.sh (provides cloud_install_log).
#
# Env:
#   CLOUD_INSTALL_PLAYWRIGHT=0          Skip Playwright browser install entirely.
#   CLOUD_INSTALL_PLAYWRIGHT_STRICT=1   Fail the install script when Playwright fails (default: warn and continue).
#   CLOUD_INSTALL_PLAYWRIGHT_TIMEOUT_SECS=600   Max seconds per install attempt (default 600).
#   CLOUD_INSTALL_PLAYWRIGHT_STALE_SECS=900     Kill stuck install processes when lock is older (default 900).

_cloud_playwright_log() {
	if declare -F cloud_install_log >/dev/null 2>&1; then
		cloud_install_log "$@"
	else
		echo "cloud-install: $*"
	fi
}

_playwright_browsers_cache_path() {
	printf '%s\n' "${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
}

# Kill Playwright download/install subprocesses when a lock has been held too long (post-100% hang).
_clear_stale_playwright_install_processes() {
	local browsers_path lock stale_secs now lock_mtime age
	browsers_path="$(_playwright_browsers_cache_path)"
	lock="${browsers_path}/__dirlock"
	stale_secs="${CLOUD_INSTALL_PLAYWRIGHT_STALE_SECS:-900}"
	now="$(date +%s)"
	lock_mtime="$now"
	if [[ -d "$lock" ]]; then
		lock_mtime="$(stat -c %Y "$lock" 2>/dev/null || echo "$now")"
	fi
	age=$((now - lock_mtime))

	if ! pgrep -f 'oopDownloadBrowserMain|playwright install|npm exec playwright install' >/dev/null 2>&1; then
		rm -rf "$lock" 2>/dev/null || true
		return 0
	fi

	if ((age < stale_secs)); then
		echo "cloud-install: Playwright — another browser install is in progress (lock age ${age}s)." >&2
		echo "cloud-install: Playwright — do not run parallel installs; wait or remove stale processes first." >&2
		return 1
	fi

	_cloud_playwright_log "Playwright — clearing stale install (lock age ${age}s)"
	pkill -f oopDownloadBrowserMain 2>/dev/null || true
	pkill -f 'playwright install' 2>/dev/null || true
	pkill -f 'npm exec playwright install' 2>/dev/null || true
	sleep 1
	rm -rf "$lock" 2>/dev/null || true
}

_prepare_playwright_install_lock() {
	local browsers_path
	browsers_path="$(_playwright_browsers_cache_path)"
	_clear_stale_playwright_install_processes
	rm -rf "${browsers_path}/__dirlock" 2>/dev/null || true
}

# Playwright's oopDownloadBrowserMain often hangs after zip download on Cursor Cloud VMs; recover from /tmp.
_recover_playwright_from_temp_downloads() {
	local browsers_path chromium_zip headless_zip
	browsers_path="$(_playwright_browsers_cache_path)"
	chromium_zip="$(find /tmp/playwright-download-* -maxdepth 1 -name 'playwright-download-chromium-ubuntu*.zip' -type f 2>/dev/null | sort -r | head -1)"
	headless_zip="$(find /tmp/playwright-download-* -maxdepth 1 -name 'playwright-download-chromium-headless-shell*.zip' -type f 2>/dev/null | sort -r | head -1)"

	if [[ -n "$chromium_zip" && ! -x "${browsers_path}/chromium-1217/chrome-linux64/chrome" ]]; then
		_cloud_playwright_log "Playwright — recovering chromium from ${chromium_zip}"
		rm -rf "${browsers_path}/chromium-1217"
		mkdir -p "${browsers_path}/chromium-1217"
		unzip -qo "$chromium_zip" -d "${browsers_path}/chromium-1217"
	fi

	if [[ -n "$headless_zip" && ! -x "${browsers_path}/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell" ]]; then
		_cloud_playwright_log "Playwright — recovering headless shell from ${headless_zip}"
		rm -rf "${browsers_path}/chromium_headless_shell-1217"
		mkdir -p "${browsers_path}/chromium_headless_shell-1217"
		unzip -qo "$headless_zip" -d "${browsers_path}/chromium_headless_shell-1217"
	fi
}

# Wraps fleet install_playwright_browsers_for_e2e with timeout and non-fatal failure by default.
install_playwright_browsers_for_cloud() {
	local repo_root timeout_secs browsers_path rc
	repo_root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
	timeout_secs="${CLOUD_INSTALL_PLAYWRIGHT_TIMEOUT_SECS:-600}"
	browsers_path="$(_playwright_browsers_cache_path)"

	if [[ "${CLOUD_INSTALL_PLAYWRIGHT:-1}" != "1" ]]; then
		_cloud_playwright_log "Playwright — skipped (CLOUD_INSTALL_PLAYWRIGHT=${CLOUD_INSTALL_PLAYWRIGHT})"
		return 0
	fi

	if ! _prepare_playwright_install_lock; then
		if [[ "${CLOUD_INSTALL_PLAYWRIGHT_STRICT:-0}" == "1" ]]; then
			return 1
		fi
		echo "cloud-install: Playwright — skipped due to concurrent install; npm test still works" >&2
		return 0
	fi

	_cloud_playwright_log "Playwright — installing chromium + headless shell (timeout ${timeout_secs}s)"
	rc=0
	if ! timeout "$timeout_secs" bash -c '
		# shellcheck source=/dev/null
		source "$0/.agents/scripts/cloud-install-lib.sh"
		install_playwright_browsers_for_e2e
	' "$repo_root"; then
		rc=$?
	fi

	rm -rf "${browsers_path}/__dirlock" 2>/dev/null || true
	pkill -f oopDownloadBrowserMain 2>/dev/null || true
	pkill -f 'playwright install' 2>/dev/null || true

	if [[ "$rc" -ne 0 ]]; then
		_recover_playwright_from_temp_downloads
		# shellcheck source=/dev/null
		source "${repo_root}/.agents/scripts/cloud-install-lib.sh"
		bin="$(playwright_headless_shell_bin || true)"
		if [[ -n "$bin" && -x "$bin" ]]; then
			_cloud_playwright_log "Playwright — recovered browsers from temp downloads"
			return 0
		fi
	fi

	if [[ "$rc" -eq 0 ]]; then
		_cloud_playwright_log "Playwright — browsers ready"
		return 0
	fi

	echo "cloud-install: Playwright — install failed or timed out (exit ${rc})" >&2
	echo "cloud-install: Playwright — npm test still works; npm run test:e2e may fail until browsers are installed" >&2
	echo "cloud-install: Playwright — retry: rm -rf ~/.cache/ms-playwright/__dirlock && bash scripts/cloud-agent-install.sh" >&2

	if [[ "${CLOUD_INSTALL_PLAYWRIGHT_STRICT:-0}" == "1" ]]; then
		return 1
	fi
	return 0
}
