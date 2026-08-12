#!/usr/bin/env bash
# Idempotent Cursor Cloud install/update: Docker (fuse-overlayfs), Node 24, npm ci,
# and local gitignored bootstrap files. Invoked from .cursor/environment.json.
#
# Does NOT start long-running services (see cloud-agent-start.sh). Safe to re-run
# on a partially cached snapshot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Valid-Until skew on Cloud VMs; force-conf* so dpkg never prompts on pre-existing
# conffiles (notably /etc/fuse.conf with user_allow_other on the base image —
# DEBIAN_FRONTEND=noninteractive alone does not suppress dpkg conffile prompts).
APT_OPTS=(
	-o Acquire::Check-Valid-Until=false
	-o Acquire::Check-Date=false
	-o Dpkg::Options::=--force-confdef
	-o Dpkg::Options::=--force-confold
)
NODE24_DIR="${HOME}/.nvm/versions/node/v24.18.0"
NODE24_BIN="${NODE24_DIR}/bin"

log() { printf 'cloud-install: %s\n' "$*"; }

# Heal interrupted installs (e.g. fuse3 left "unpacked" after a conffile EOF).
repair_dpkg_if_needed() {
	local needs_repair=0
	if dpkg --audit 2>/dev/null | grep -q .; then
		needs_repair=1
	elif dpkg -l fuse3 fuse-overlayfs 2>/dev/null | awk '/^iU|^iF|^iH/ {found=1} END {exit !found}'; then
		needs_repair=1
	fi
	if [[ "$needs_repair" -eq 1 ]]; then
		log "repairing half-configured apt packages (noninteractive conffiles)"
		sudo env DEBIAN_FRONTEND=noninteractive dpkg --force-confdef --force-confold --configure -a
	fi
}

ensure_apt_packages() {
	repair_dpkg_if_needed

	if command -v dockerd >/dev/null 2>&1 && command -v fuse-overlayfs >/dev/null 2>&1; then
		log "docker + fuse-overlayfs already installed"
		return 0
	fi

	log "installing docker + fuse-overlayfs (apt; ignoring Valid-Until skew)"
	sudo apt-get "${APT_OPTS[@]}" update -qq
	sudo env DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y -qq \
		ca-certificates curl gnupg fuse-overlayfs uidmap iptables

	if ! command -v dockerd >/dev/null 2>&1; then
		sudo install -m 0755 -d /etc/apt/keyrings
		if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
			curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
				sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
			sudo chmod a+r /etc/apt/keyrings/docker.gpg
		fi
		# shellcheck disable=SC1091
		. /etc/os-release
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" |
			sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
		sudo apt-get "${APT_OPTS[@]}" update -qq
		sudo env DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y -qq \
			docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	fi
}

configure_docker() {
	sudo mkdir -p /etc/docker
	sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "storage-driver": "fuse-overlayfs",
  "features": { "containerd-snapshotter": false }
}
EOF
	# Nested Docker on Cloud Agents needs iptables-legacy.
	if [[ -x /usr/sbin/iptables-legacy ]]; then
		sudo update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null || true
		sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null || true
	fi
	sudo groupadd -f docker
	sudo usermod -aG docker "${USER:-ubuntu}" 2>/dev/null || true
	log "wrote /etc/docker/daemon.json (fuse-overlayfs)"
}

ensure_node24() {
	export NVM_DIR="${HOME}/.nvm"
	if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
		log "installing nvm"
		curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
	fi
	# shellcheck disable=SC1091
	. "${NVM_DIR}/nvm.sh"
	if [[ ! -x "${NODE24_BIN}/node" ]]; then
		log "installing Node 24 via nvm"
		nvm install 24
	fi
	nvm alias default 24 >/dev/null
	# Defeat /exec-daemon node v22 that Cursor injects ahead of nvm on PATH.
	export PATH="${NODE24_BIN}:${PATH}"
	log "node=$(node -v) npm=$(npm -v)"
}

configure_shell_env() {
	local marker="# stocktextalerts-cloud-agent-env"
	if ! grep -qF "$marker" "${HOME}/.bashrc" 2>/dev/null; then
		cat >>"${HOME}/.bashrc" <<EOF

${marker}
prefer_node24() {
  local n24="${NODE24_BIN}"
  case ":\$PATH:" in
    *":\$n24:"*) PATH="\$n24:\${PATH//:\$n24:/:}"; PATH="\${PATH%:}" ;;
    *) PATH="\$n24:\$PATH" ;;
  esac
  export PATH
  export DOCKER_HOST="\${DOCKER_HOST:-unix:///var/run/docker.sock}"
}
prefer_node24
PROMPT_COMMAND="prefer_node24\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
EOF
		log "appended Node 24 + DOCKER_HOST helpers to ~/.bashrc"
	fi
	export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
}

bootstrap_local_files() {
	mkdir -p scripts/data
	if [[ ! -f scripts/data/users.json && -f scripts/data/sample-users.json ]]; then
		cp scripts/data/sample-users.json scripts/data/users.json
		log "copied scripts/data/users.json"
	fi

	if [[ ! -f .env.local ]]; then
		cp env.example .env.local
		# Local-only stubs so npm scripts can boot; supabase keys filled after db:start.
		local pass
		pass="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
		python3 - "$pass" <<'PY'
import pathlib, re, secrets, sys
password = sys.argv[1]
p = pathlib.Path(".env.local")
text = p.read_text()
replacements = {
	"<your-domain>": "stocktextalerts.local",
	"<supabase-publishable-key>": "pending",
	"<supabase-secret-key>": "pending",
	"<unsubscribe-token-secret>": secrets.token_hex(32),
	"<admin-email>": "dev@example.com",
	"<email-dispatch-secret>": secrets.token_hex(32),
	"<massive-api-key>": "placeholder",
	"<finnhub-api-key>": "placeholder",
	"<telegram-bot-token>": "000000000:PLACEHOLDER",
	"<telegram-bot-username>": "SollyClawBot",
	"<telegram-webhook-secret>": secrets.token_hex(16),
	"<telegram-link-token-secret>": secrets.token_hex(32),
	"<local-seed-password>": password,
}
for k, v in replacements.items():
	text = text.replace(k, v)
text = re.sub(r"(?m)^EMAIL_SMTP_HOST=.*$", "EMAIL_SMTP_HOST=localhost", text)
p.write_text(text)
PY
		log "created .env.local from env.example"
	fi
}

npm_ci_if_needed() {
	export PATH="${NODE24_BIN}:${PATH}"
	if [[ ! -d node_modules/.bin ]]; then
		log "running npm ci"
		npm ci
	else
		log "node_modules present; skipping npm ci"
	fi
}

main() {
	ensure_apt_packages
	configure_docker
	ensure_node24
	configure_shell_env
	bootstrap_local_files
	npm_ci_if_needed
	log "done"
}

main "$@"
