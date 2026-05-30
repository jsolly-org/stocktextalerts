#!/usr/bin/env bash
# StockTextAlerts Cursor Cloud — Docker + local Supabase bootstrap.
# Source from scripts/cloud-agent-install.sh (app-local; not in dotagents fleet subtree).

# Cursor Cloud VMs often lack Docker Desktop. Supabase local dev needs a working engine plus
# bridge networking between containers (realtime schema init → postgres). Without
# iptables-legacy, supabase start fails at "Initialising schema" with DBConnection timeouts.
install_docker_for_supabase() {
	if ! command -v apt-get >/dev/null 2>&1; then
		if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
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
		sudo apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt_packages[@]}"
	fi

	if command -v update-alternatives >/dev/null 2>&1 && [[ -x /usr/sbin/iptables-legacy ]]; then
		if sudo update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null; then
			docker_needs_restart=1
		fi
		if sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null; then
			docker_needs_restart=1
		fi
	fi

	sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null 2>&1 || true

	sudo mkdir -p /etc/docker
	if [[ ! -f /etc/docker/daemon.json ]]; then
		# overlay2 often fails on cloud VMs (invalid argument); vfs is slower but reliable.
		printf '%s\n' '{"storage-driver":"vfs","exec-opts":["native.cgroupdriver=cgroupfs"]}' | sudo tee /etc/docker/daemon.json >/dev/null
		docker_needs_restart=1
	fi

	ensure_docker_daemon_running "$docker_needs_restart"
}

force_restart_docker_daemon() {
	if command -v systemctl >/dev/null 2>&1; then
		sudo systemctl restart docker 2>/dev/null || true
		sleep 2
		if docker info >/dev/null 2>&1; then
			return 0
		fi
	fi

	if command -v dockerd >/dev/null 2>&1; then
		sudo pkill dockerd 2>/dev/null || true
		sleep 1
		sudo bash -c 'dockerd >/tmp/dockerd.log 2>&1 &'
		local attempt=0
		while [[ $attempt -lt 60 ]]; do
			if docker info >/dev/null 2>&1; then
				return 0
			fi
			attempt=$((attempt + 1))
			sleep 1
		done
		echo "dockerd failed to restart; last lines of /tmp/dockerd.log:" >&2
		tail -40 /tmp/dockerd.log >&2 || true
		exit 1
	fi

	sudo service docker restart 2>/dev/null || true
	sleep 2
	if docker info >/dev/null 2>&1; then
		return 0
	fi

	echo "Docker daemon restart failed (docker info still unreachable)" >&2
	exit 1
}

ensure_docker_daemon_running() {
	local force_restart="${1:-0}"

	if [[ "$force_restart" -eq 1 ]]; then
		force_restart_docker_daemon
		return 0
	fi

	if docker info >/dev/null 2>&1; then
		return 0
	fi

	if [[ -S /var/run/docker.sock ]] && ! docker info >/dev/null 2>&1; then
		sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
		if docker info >/dev/null 2>&1; then
			return 0
		fi
	fi

	if command -v dockerd >/dev/null 2>&1; then
		sudo pkill dockerd 2>/dev/null || true
		sleep 1
		sudo bash -c 'dockerd >/tmp/dockerd.log 2>&1 &'
		local attempt=0
		while [[ $attempt -lt 60 ]]; do
			if docker info >/dev/null 2>&1; then
				return 0
			fi
			attempt=$((attempt + 1))
			sleep 1
		done
		echo "dockerd failed to start; last lines of /tmp/dockerd.log:" >&2
		tail -40 /tmp/dockerd.log >&2 || true
		exit 1
	fi

	sudo service docker start 2>/dev/null || sudo systemctl start docker 2>/dev/null || true
	sleep 2
	if docker info >/dev/null 2>&1; then
		return 0
	fi

	echo "Docker daemon is not reachable (docker info failed)" >&2
	exit 1
}

# Same exclude list as .github/actions/run-ci/action.yml (Podman/cloud-friendly).
supabase_start_for_cloud() {
	local supabase_bin="$1"
	"$supabase_bin" start -x studio,imgproxy,logflare,vector,postgres-meta,edge-runtime,realtime,storage-api
}

# Writes .env.local from `supabase status -o json` plus caller-provided static lines (CI/cloud dummy creds).
write_cloud_env_local_from_supabase() {
	local supabase_bin="$1"
	local env_file="$2"
	local static_vars="$3"
	local status_json
	status_json="$(mktemp)"
	"$supabase_bin" status -o json >"$status_json"

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
		exit 1
	fi

	printf '%s\n%s\n' "$db_vars" "$static_vars" >"$env_file"
}
