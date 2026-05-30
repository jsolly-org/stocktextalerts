#!/usr/bin/env bash
# Shared Cursor Cloud install helpers. Source from repo scripts/cloud-agent-install.sh:
#   source "$(cd "$(dirname "$0")/.." && pwd)/.agents/scripts/cloud-install-lib.sh"
#
# Provides: ensure_node_version, use_node_for_cursor_cloud, install_zip_unzip, install_aws_cli,
# install_sam, install_yaml_linters, install_docker_for_supabase, write_cloud_env_local_from_supabase

ensure_node_version() {
	local required_major
	required_major="$(cat .nvmrc 2>/dev/null || echo 24)"
	required_major="${required_major%%.*}"

	if command -v node >/dev/null 2>&1; then
		local major
		major="$(node -p "process.versions.node.split('.')[0]")"
		if [[ "$major" -ge "$required_major" ]]; then
			node -v
			return 0
		fi
	fi

	if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
		# shellcheck source=/dev/null
		. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
		nvm install "$required_major"
		nvm use "$required_major"
		node -v
		return 0
	fi

	echo "Node ${required_major} required but nvm unavailable" >&2
	exit 1
}

# Cursor cloud VMs put /exec-daemon Node 22 ahead of nvm on PATH — ensure_node_version alone is not enough.
use_node_for_cursor_cloud() {
	local required_major
	required_major="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || echo 24)"
	required_major="${required_major%%.*}"

	ensure_node_version

	if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
		# shellcheck source=/dev/null
		. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
		export PATH="$(dirname "$(nvm which "$required_major")"):$PATH"
	fi

	local major
	major="$(node -p "process.versions.node.split('.')[0]")"
	if [[ "$major" -lt "$required_major" ]]; then
		echo "Expected Node >= ${required_major}, got: $(node -v)" >&2
		exit 1
	fi

	persist_cursor_node_shell "$required_major"
	node -v
}

persist_cursor_node_shell() {
	local required_major="${1:-24}"
	local marker="cursor-cloud-agent-node${required_major}"
	local profile="$HOME/.bashrc"

	if [[ ! -f "$profile" ]] || grep -q "$marker" "$profile" 2>/dev/null; then
		return 0
	fi

	cat >>"$profile" <<EOF

# --- ${marker} (fleet cloud-install-lib.sh) ---
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm install ${required_major} >/dev/null 2>&1 || true
nvm use ${required_major} >/dev/null 2>&1 || true
if nvm which ${required_major} >/dev/null 2>&1; then
  export PATH="\$(dirname "\$(nvm which ${required_major})"):\$PATH"
fi
# --- end ${marker} ---
EOF
}

install_zip_unzip() {
	if ! command -v apt-get >/dev/null 2>&1; then
		return 0
	fi
	for pkg in zip unzip; do
		if ! command -v "$pkg" >/dev/null 2>&1; then
			sudo apt-get update -qq
			sudo apt-get install -y -qq zip unzip
			break
		fi
	done
}

install_sam() {
	install_zip_unzip
	if command -v sam >/dev/null 2>&1; then
		sam --version
		return 0
	fi
	local arch sam_arch
	arch="$(uname -m)"
	case "$arch" in
		aarch64 | arm64) sam_arch=arm64 ;;
		x86_64 | amd64) sam_arch=x86_64 ;;
		*)
			echo "Unsupported architecture for SAM CLI install: $arch" >&2
			exit 1
			;;
	esac
	curl -fsSL "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${sam_arch}.zip" \
		-o /tmp/sam.zip
	unzip -q /tmp/sam.zip -d /tmp/sam
	sudo /tmp/sam/install
	sam --version
}

install_aws_cli() {
	if command -v aws >/dev/null 2>&1; then
		aws --version
		return 0
	fi
	install_zip_unzip
	local arch aws_arch
	arch="$(uname -m)"
	case "$arch" in
		aarch64 | arm64) aws_arch=aarch64 ;;
		x86_64 | amd64) aws_arch=x86_64 ;;
		*)
			echo "Unsupported architecture for AWS CLI install: $arch" >&2
			exit 1
			;;
	esac
	curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip
	# Zip root is `aws/` — extract to /tmp so install lands at /tmp/aws/install.
	rm -rf /tmp/aws
	unzip -q /tmp/awscliv2.zip -d /tmp
	sudo /tmp/aws/install
	aws --version
}

# pip --user / pipx install to ~/.local/bin; cloud shells often omit it from PATH.
ensure_user_local_bin_on_path() {
	export PATH="${HOME}/.local/bin:${PATH}"
}

install_yaml_linters() {
	ensure_user_local_bin_on_path
	# Pin versions to match stocktextalerts CI (noDeploy.yml).
	if ! command -v yamllint >/dev/null 2>&1; then
		if command -v pipx >/dev/null 2>&1; then
			pipx install yamllint==1.38.0
		elif command -v pip3 >/dev/null 2>&1; then
			pip3 install --user yamllint==1.38.0
		else
			echo "yamllint not found and pipx/pip3 unavailable" >&2
			exit 1
		fi
	fi
	if ! command -v actionlint >/dev/null 2>&1; then
		bash <(curl -sSf https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) 1.7.12
		sudo mv actionlint /usr/local/bin/actionlint
	fi
	yamllint --version
	actionlint -version
}

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
		sudo update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true
		sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true
	fi

	sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null 2>&1 || true
	sudo sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null 2>&1 || true

	sudo mkdir -p /etc/docker
	if [[ ! -f /etc/docker/daemon.json ]]; then
		# overlay2 often fails on cloud VMs (invalid argument); vfs is slower but reliable.
		printf '%s\n' '{"storage-driver":"vfs","exec-opts":["native.cgroupdriver=cgroupfs"]}' | sudo tee /etc/docker/daemon.json >/dev/null
	fi

	ensure_docker_daemon_running
}

ensure_docker_daemon_running() {
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
		sudo dockerd >/tmp/dockerd.log 2>&1 &
		local i
		for i in $(seq 1 60); do
			if docker info >/dev/null 2>&1; then
				return 0
			fi
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
