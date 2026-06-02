#!/usr/bin/env bash
# StockTextAlerts Cursor Cloud — Docker + local Supabase bootstrap.
# Source from scripts/cloud-agent-install.sh (app-local; not in dotagents fleet subtree).

cloud_install_log() {
	echo "cloud-install: $*" >&2
}

# Cursor Cloud VMs often lack Docker Desktop. Supabase local dev needs a working engine plus
# bridge networking between containers (realtime schema init → postgres). Without
# iptables-legacy, supabase start fails at "Initialising schema" with DBConnection timeouts.
install_docker_for_supabase() {
	cloud_install_log "Docker — checking prerequisites"
	if ! command -v apt-get >/dev/null 2>&1; then
		if command -v docker >/dev/null 2>&1; then
			ensure_docker_client_access
			return 0
		fi
		echo "install_docker_for_supabase: apt-get unavailable and docker not working" >&2
		exit 1
	fi

	local docker_needs_restart=0
	local -a apt_packages=()
	if ! command -v docker >/dev/null 2>&1; then
		apt_packages+=("docker.io")
	fi
	if ! command -v jq >/dev/null 2>&1; then
		apt_packages+=("jq")
	fi
	if [[ "${#apt_packages[@]}" -gt 0 ]]; then
		cloud_install_log "Docker — apt install: ${apt_packages[*]}"
		sudo apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt_packages[@]}"
	fi

	if command -v update-alternatives >/dev/null 2>&1 && [[ -x /usr/sbin/iptables-legacy ]]; then
		if sudo update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null; then
			cloud_install_log "Docker — switched iptables to legacy"
			docker_needs_restart=1
		fi
		if sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null; then
			cloud_install_log "Docker — switched ip6tables to legacy"
			docker_needs_restart=1
		fi
	fi

	sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null 2>&1 || true

	sudo mkdir -p /etc/docker
	if [[ ! -f /etc/docker/daemon.json ]]; then
		# overlay2 often fails on cloud VMs (invalid argument); vfs is slower but reliable.
		cloud_install_log "Docker — writing /etc/docker/daemon.json (vfs storage driver)"
		printf '%s\n' '{"storage-driver":"vfs","exec-opts":["native.cgroupdriver=cgroupfs"]}' | sudo tee /etc/docker/daemon.json >/dev/null
		docker_needs_restart=1
	fi

	if [[ "$docker_needs_restart" -eq 1 ]]; then
		cloud_install_log "Docker — restarting daemon (iptables or daemon.json changed)"
	else
		cloud_install_log "Docker — ensuring daemon is running"
	fi
	ensure_docker_daemon_running "$docker_needs_restart"
	ensure_docker_client_access
}

# Returns 0 once the docker client can reach the daemon. The engine often boots
# fine on cloud VMs while `docker info` still fails with "permission denied"
# because the socket is root:docker 0660 and the agent user isn't in the
# `docker` group — chmod the socket for this session (group membership needs a new login).
docker_info_ready() {
	if docker info >/dev/null 2>&1; then
		return 0
	fi
	if [[ -S /var/run/docker.sock ]]; then
		sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
		if docker info >/dev/null 2>&1; then
			return 0
		fi
	fi
	return 1
}

# Polls docker_info_ready up to "$1" seconds (default 60).
wait_for_docker_ready() {
	local timeout="${1:-60}" attempt=0
	while [[ $attempt -lt $timeout ]]; do
		if docker_info_ready; then
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 1
	done
	return 1
}

# Dumps why `docker info` is failing. Distinguishes a dead daemon (dockerd.log
# has the failure) from a client-side socket-permission problem (daemon booted
# fine but the socket is unreachable for this user).
dump_docker_diagnostics() {
	echo "--- docker diagnostics ---" >&2
	echo "user/groups: $(id 2>&1)" >&2
	echo "socket: $(ls -l /var/run/docker.sock 2>&1)" >&2
	echo "dockerd processes: $(pgrep -a dockerd 2>&1 || echo none)" >&2
	echo "docker info error:" >&2
	docker info 2>&1 | tail -8 >&2 || true
	echo "last lines of /tmp/dockerd.log:" >&2
	tail -40 /tmp/dockerd.log >&2 2>/dev/null || true
}

dump_supabase_diagnostics() {
	local supabase_bin="${1:-supabase}"
	echo "--- supabase diagnostics ---" >&2
	dump_supabase_cli_diagnostics "$supabase_bin"
	dump_docker_diagnostics
	echo "supabase status:" >&2
	"$supabase_bin" status 2>&1 >&2 || true
	echo "docker containers (supabase*):" >&2
	docker ps -a --filter name=supabase --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 >&2 || true
}

dump_supabase_cli_diagnostics() {
	local supabase_bin="${1:-supabase}"
	local repo_root="${REPO_ROOT:-$(pwd)}"
	echo "--- supabase cli diagnostics ---" >&2
	echo "node: $(node -v 2>&1 || true)" >&2
	echo "npm: $(npm -v 2>&1 || true)" >&2
	echo "NODE_ENV=${NODE_ENV:-}" >&2
	echo "npm_config_omit=${npm_config_omit:-}" >&2
	echo "npm config ignore-scripts: $(npm config get ignore-scripts 2>&1 || true)" >&2
	echo "npm config omit: $(npm config get omit 2>&1 || true)" >&2
	echo "supabase_bin: $supabase_bin" >&2
	ls -la "$supabase_bin" "$repo_root/node_modules/supabase/bin" 2>&1 >&2 || true
}

npm_ci_for_cloud() {
	local repo_root="${1:-${REPO_ROOT:-$(pwd)}}"
	local max_attempts=3 attempt=1 backoff=2 rc

	while [[ $attempt -le $max_attempts ]]; do
		cloud_install_log "npm ci — attempt $attempt/$max_attempts"
		set +e
		(cd "$repo_root" && npm ci --include=dev --foreground-scripts --ignore-scripts=false)
		rc=$?
		set -e

		if [[ $rc -eq 0 ]]; then
			return 0
		fi

		if [[ $attempt -eq $max_attempts ]]; then
			echo "Error: npm ci failed after $max_attempts attempts (exit $rc)." >&2
			dump_supabase_cli_diagnostics "$repo_root/node_modules/.bin/supabase"
			exit "$rc"
		fi

		cloud_install_log "npm ci — transient failure, retrying in ${backoff}s"
		sleep "$backoff"
		backoff=$((backoff * 2))
		attempt=$((attempt + 1))
	done

	return 1
}

supabase_cli_ready_for_cloud() {
	local repo_root="${1:-${REPO_ROOT:-$(pwd)}}"
	local supabase_bin="${2:-$repo_root/node_modules/.bin/supabase}"
	local supabase_real_bin="$repo_root/node_modules/supabase/bin/supabase"

	[[ -x "$supabase_bin" && -x "$supabase_real_bin" ]] || return 1
	"$supabase_bin" --version >/dev/null 2>&1
}

ensure_supabase_cli_for_cloud() {
	local repo_root="${1:-${REPO_ROOT:-$(pwd)}}"
	local supabase_bin="$repo_root/node_modules/.bin/supabase"
	local max_attempts=3 attempt=1 backoff=2 version

	if supabase_cli_ready_for_cloud "$repo_root" "$supabase_bin"; then
		version="$("$supabase_bin" --version 2>/dev/null || true)"
		cloud_install_log "Supabase CLI — ready ($version)"
		return 0
	fi

	cloud_install_log "Supabase CLI — missing or not executable after npm ci"
	while [[ $attempt -le $max_attempts ]]; do
		cloud_install_log "Supabase CLI — npm rebuild attempt $attempt/$max_attempts"
		if (cd "$repo_root" && npm rebuild supabase --foreground-scripts --ignore-scripts=false); then
			if supabase_cli_ready_for_cloud "$repo_root" "$supabase_bin"; then
				version="$("$supabase_bin" --version 2>/dev/null || true)"
				cloud_install_log "Supabase CLI — ready ($version)"
				return 0
			fi
		fi

		if [[ $attempt -lt $max_attempts ]]; then
			sleep "$backoff"
			backoff=$((backoff * 2))
		fi
		attempt=$((attempt + 1))
	done

	echo "Error: Supabase CLI not found or not executable at $supabase_bin after npm rebuild." >&2
	dump_supabase_cli_diagnostics "$supabase_bin"
	exit 1
}

# Group membership does not apply until a new login; chmod the socket so this install
# session can run `docker` / `supabase` immediately. Re-chmod after daemon restarts
# via docker_info_ready inside wait loops.
ensure_docker_client_access() {
	local user="${SUDO_USER:-${USER:-}}"
	if [[ -z "$user" || "$user" == "root" ]]; then
		user="$(id -un 2>/dev/null || true)"
	fi

	if [[ -n "$user" && "$user" != "root" ]] && getent group docker >/dev/null 2>&1; then
		if ! id -nG "$user" 2>/dev/null | grep -qw docker; then
			cloud_install_log "Docker — adding $user to docker group (new shells only)"
			sudo usermod -aG docker "$user" 2>/dev/null || true
		fi
	fi

	if docker_info_ready; then
		local version
		version="$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo unknown)"
		cloud_install_log "Docker — client ok (server $version)"
		return 0
	fi

	cloud_install_log "Docker — client still cannot reach daemon"
	dump_docker_diagnostics
	exit 1
}

force_restart_docker_daemon() {
	if command -v systemctl >/dev/null 2>&1; then
		sudo systemctl restart docker 2>/dev/null || true
		sleep 2
		if docker_info_ready; then
			return 0
		fi
	fi

	if command -v dockerd >/dev/null 2>&1; then
		sudo pkill dockerd 2>/dev/null || true
		sleep 1
		sudo bash -c 'dockerd >/tmp/dockerd.log 2>&1 &'
		if wait_for_docker_ready 60; then
			return 0
		fi
		echo "dockerd failed to restart within 60s." >&2
		dump_docker_diagnostics
		exit 1
	fi

	sudo service docker restart 2>/dev/null || true
	sleep 2
	if docker_info_ready; then
		return 0
	fi

	echo "Docker daemon restart failed (docker info still unreachable)" >&2
	dump_docker_diagnostics
	exit 1
}

ensure_docker_daemon_running() {
	local force_restart="${1:-0}"

	if [[ "$force_restart" -eq 1 ]]; then
		force_restart_docker_daemon
		return 0
	fi

	if docker_info_ready; then
		return 0
	fi

	if command -v dockerd >/dev/null 2>&1; then
		sudo pkill dockerd 2>/dev/null || true
		sleep 1
		sudo bash -c 'dockerd >/tmp/dockerd.log 2>&1 &'
		if wait_for_docker_ready 60; then
			return 0
		fi
		echo "dockerd failed to start within 60s." >&2
		dump_docker_diagnostics
		exit 1
	fi

	sudo service docker start 2>/dev/null || sudo systemctl start docker 2>/dev/null || true
	sleep 2
	if docker_info_ready; then
		return 0
	fi

	echo "Docker daemon is not reachable (docker info failed)" >&2
	dump_docker_diagnostics
	exit 1
}

# Resolve the local Postgres container name (e.g. supabase_db_stocktextalerts).
supabase_db_container_name() {
	docker ps --filter "name=supabase_db_" --format '{{.Names}}' 2>/dev/null | head -n1
}

# Poll until Postgres accepts connections. Cloud VMs often fail db:reset with
# "failed to create migration table: unexpected EOF" when migrations run while
# the DB container is still health: starting after a recreate.
wait_for_supabase_postgres_healthy() {
	local timeout="${1:-120}" attempt=0 container health
	container="$(supabase_db_container_name)"
	if [[ -z "$container" ]]; then
		cloud_install_log "Postgres — no supabase_db_* container yet (will retry)"
	fi

	while [[ $attempt -lt $timeout ]]; do
		container="$(supabase_db_container_name)"
		if [[ -n "$container" ]]; then
			health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo unknown)"
			if [[ "$health" == "healthy" ]]; then
				cloud_install_log "Postgres — $container is healthy"
				return 0
			fi
			if [[ "$health" == "none" ]] && docker exec "$container" pg_isready -U postgres -q 2>/dev/null; then
				cloud_install_log "Postgres — $container accepts connections (pg_isready)"
				return 0
			fi
		fi
		attempt=$((attempt + 2))
		sleep 2
	done

	cloud_install_log "Postgres — not healthy within ${timeout}s"
	return 1
}

# db:reset recreates the DB; retry transient EOF / not-ready failures on cloud VMs.
db_reset_for_cloud() {
	local max_attempts=3 attempt=1 backoff=5 output rc

	while [[ $attempt -le $max_attempts ]]; do
		cloud_install_log "db:reset — attempt $attempt/$max_attempts"
		if ! wait_for_supabase_postgres_healthy 120; then
			cloud_install_log "db:reset — Postgres not ready before attempt $attempt"
		fi

		set +e
		output="$(npm run db:reset 2>&1)"
		rc=$?
		set -e
		printf '%s\n' "$output"

		if [[ $rc -eq 0 ]]; then
			cloud_install_log "db:reset — ok"
			return 0
		fi

		if [[ "$output" != *"unexpected EOF"* && "$output" != *"not ready"* && "$output" != *"starting"* ]]; then
			cloud_install_log "db:reset — non-retryable failure (exit $rc)"
			return "$rc"
		fi

		if [[ $attempt -eq $max_attempts ]]; then
			cloud_install_log "db:reset — exhausted retries (exit $rc)"
			dump_supabase_diagnostics "${SUPABASE_BIN:-supabase}" || true
			return "$rc"
		fi

		cloud_install_log "db:reset — transient failure, retrying in ${backoff}s"
		sleep "$backoff"
		backoff=$((backoff * 2))
		attempt=$((attempt + 1))
	done

	return 1
}

# After a fresh dockerd restart, give the engine a moment before Supabase creates networks.
cloud_install_settle_docker_before_supabase() {
	cloud_install_log "Docker — settling before Supabase (post-restart)"
	sleep 3
	if ! wait_for_docker_ready 30; then
		cloud_install_log "Docker — not ready after settle wait"
		dump_docker_diagnostics
		exit 1
	fi
}

# Remove orphaned Supabase containers/networks from a partial `supabase start` (common on cloud VMs).
supabase_clean_docker_state_for_cloud() {
	local supabase_bin="${1:-supabase}"
	cloud_install_log "Supabase — cleaning stale Docker containers/networks"
	if supabase_cli_ready_for_cloud "${REPO_ROOT:-$(pwd)}" "$supabase_bin"; then
		"$supabase_bin" stop --no-backup 2>/dev/null || true
	else
		cloud_install_log "Supabase CLI — not available for stop ($supabase_bin); skipping supabase stop"
	fi
	local ids
	ids="$(docker ps -aq --filter name=supabase 2>/dev/null || true)"
	if [[ -n "$ids" ]]; then
		# shellcheck disable=SC2086
		docker rm -f $ids 2>/dev/null || true
	fi
	local networks
	networks="$(docker network ls --filter name=supabase_network -q 2>/dev/null || true)"
	if [[ -n "$networks" ]]; then
		# shellcheck disable=SC2086
		docker network rm $networks 2>/dev/null || true
	fi
}

supabase_start_error_is_retryable() {
	local output="$1"
	[[ "$output" == *"network supabase_network"* && "$output" == *"not found"* ]] && return 0
	[[ "$output" == *"already in use"* ]] && return 0
	[[ "$output" == *"Conflict."* || "$output" == *"Conflict:"* ]] && return 0
	[[ "$output" == *"Postgres not healthy after supabase start"* ]] && return 0
	return 1
}

# Same exclude list as .github/actions/run-ci/action.yml (Podman/cloud-friendly).
supabase_start_for_cloud() {
	local supabase_bin="$1"
	local max_attempts=3 attempt=1 backoff=5 output rc

	if ! supabase_cli_ready_for_cloud "${REPO_ROOT:-$(pwd)}" "$supabase_bin"; then
		echo "Error: Supabase CLI missing or unusable before supabase start: $supabase_bin" >&2
		dump_supabase_cli_diagnostics "$supabase_bin"
		exit 1
	fi

	cloud_install_settle_docker_before_supabase
	supabase_clean_docker_state_for_cloud "$supabase_bin"

	while [[ $attempt -le $max_attempts ]]; do
		cloud_install_log "Supabase — start attempt $attempt/$max_attempts (cloud service excludes)"
		set +e
		output="$("$supabase_bin" start -x studio,imgproxy,logflare,vector,postgres-meta,edge-runtime,realtime,storage-api 2>&1)"
		rc=$?
		set -e
		printf '%s\n' "$output"

		if [[ $rc -eq 0 ]]; then
			if wait_for_supabase_postgres_healthy 120; then
				cloud_install_log "Supabase — started"
				return 0
			fi
			output="${output}"$'\n'"Postgres not healthy after supabase start"
			rc=1
		fi

		if ! supabase_start_error_is_retryable "$output"; then
			cloud_install_log "Supabase — non-retryable start failure (exit $rc)"
			echo "supabase start failed" >&2
			dump_supabase_diagnostics "$supabase_bin"
			exit 1
		fi

		if [[ $attempt -eq $max_attempts ]]; then
			cloud_install_log "Supabase — exhausted start retries (exit $rc)"
			echo "supabase start failed" >&2
			dump_supabase_diagnostics "$supabase_bin"
			exit 1
		fi

		cloud_install_log "Supabase — transient start failure, cleaning and retrying in ${backoff}s"
		supabase_clean_docker_state_for_cloud "$supabase_bin"
		sleep "$backoff"
		backoff=$((backoff * 2))
		attempt=$((attempt + 1))
	done

	return 1
}

# Writes .env.local from `supabase status -o json` plus caller-provided static lines (CI/cloud dummy creds).
write_cloud_env_local_from_supabase() {
	local supabase_bin="$1"
	local env_file="$2"
	local static_vars="$3"
	local status_json
	status_json="$(mktemp)"
	if ! "$supabase_bin" status -o json >"$status_json"; then
		rm -f "$status_json"
		echo "Error: supabase status -o json failed (is the stack running?)" >&2
		dump_supabase_diagnostics "$supabase_bin"
		exit 1
	fi

	local db_vars invalid=0 nonempty=0
	db_vars="$(
		jq -r '
			"SUPABASE_URL=\(.API_URL // "")",
			"SUPABASE_PUBLISHABLE_KEY=\(.ANON_KEY // "")",
			"SUPABASE_SECRET_KEY=\(.SERVICE_ROLE_KEY // "")",
			"DATABASE_URL=\(.DB_URL // "")"
		' "$status_json"
	)"
	rm -f "$status_json"

	declare -A seen_keys=()
	local line key value trimmed
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		nonempty=$((nonempty + 1))
		if [[ "$line" != *"="* ]]; then
			echo "Error: Supabase env var line is malformed (expected KEY=VALUE): $line" >&2
			invalid=1
			continue
		fi
		key="${line%%=*}"
		value="${line#*=}"
		seen_keys["$key"]=1
		trimmed="${value//[[:space:]]/}"
		if [[ -z "$trimmed" || "$value" == "null" ]]; then
			echo "Error: Supabase status did not provide a valid value for $key (got '$value')." >&2
			invalid=1
		fi
	done <<<"$db_vars"

	for key in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY DATABASE_URL; do
		if [[ -z "${seen_keys[$key]:-}" ]]; then
			echo "Error: Supabase env var $key was not produced by jq." >&2
			invalid=1
		fi
	done
	if [[ "$nonempty" -eq 0 ]]; then
		echo "Error: jq produced no Supabase env vars." >&2
		invalid=1
	fi
	if [[ "$invalid" -ne 0 ]]; then
		echo "Error: Refusing to write $env_file with null/empty Supabase values." >&2
		dump_supabase_diagnostics "$supabase_bin"
		exit 1
	fi

	printf '%s\n%s\n' "$db_vars" "$static_vars" >"$env_file"
	cloud_install_log "Supabase — wrote $env_file"
}
