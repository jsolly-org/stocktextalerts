#!/usr/bin/env bash
# Cursor Cloud start hook: bring up dockerd (no systemd) and the local Supabase
# stack so agents can use the database without rediscovering Docker setup.
# Idempotent. Invoked from .cursor/environment.json "start".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE24_BIN=""
# Prefer any installed Node 24.x (nvm install 24 tracks latest patch; do not hardcode).
for _sta_node24 in "${HOME}"/.nvm/versions/node/v24.*/bin; do
	if [[ -x "${_sta_node24}/node" ]]; then
		NODE24_BIN="${_sta_node24}"
	fi
done
unset _sta_node24
export PATH="${NODE24_BIN:+${NODE24_BIN}:}${PATH}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

log() { printf 'cloud-start: %s\n' "$*"; }

ensure_dockerd() {
	if docker info >/dev/null 2>&1; then
		log "dockerd already healthy"
		return 0
	fi

	if ! command -v dockerd >/dev/null 2>&1; then
		log "ERROR: dockerd missing — run cloud-agent-install.sh / environment install first" >&2
		exit 1
	fi

	# Ensure daemon.json exists (fresh pods after install-only snapshots).
	if [[ ! -f /etc/docker/daemon.json ]]; then
		sudo mkdir -p /etc/docker
		sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "storage-driver": "fuse-overlayfs",
  "features": { "containerd-snapshotter": false }
}
EOF
	fi

	log "starting dockerd"
	sudo pkill dockerd 2>/dev/null || true
	sleep 1
	sudo dockerd >/tmp/dockerd.log 2>&1 &

	# Socket is root:docker 660 until we chmod; usermod -aG docker does not
	# apply to this already-running shell, so widen perms while waiting.
	local i
	for i in $(seq 1 60); do
		sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
		if docker info >/dev/null 2>&1; then
			break
		fi
		sleep 1
	done

	if ! docker info >/dev/null 2>&1; then
		log "ERROR: dockerd failed to become ready; last log lines:" >&2
		tail -n 40 /tmp/dockerd.log >&2 || true
		exit 1
	fi

	sudo chmod 666 /var/run/docker.sock 2>/dev/null || true

	local driver
	driver="$(docker info --format '{{.Driver}}' 2>/dev/null || true)"
	log "dockerd ready (storage-driver=${driver})"
	if [[ "$driver" != "fuse-overlayfs" ]]; then
		log "WARN: expected fuse-overlayfs, got '${driver}' — nested Docker may fail" >&2
	fi
}

sync_supabase_keys_into_env() {
	[[ -f .env.local ]] || return 0
	[[ -x "${NODE24_BIN}/node" ]] || return 0

	if ! npx supabase status -o json >/tmp/supabase-status.json 2>/tmp/supabase-status.err; then
		log "supabase status unavailable yet (ok on first boot before db:start)"
		return 0
	fi

	python3 <<'PY'
import json, pathlib, re
status = json.load(open("/tmp/supabase-status.json"))
anon = status.get("ANON_KEY") or status.get("PUBLISHABLE_KEY")
service = status.get("SERVICE_ROLE_KEY") or status.get("SECRET_KEY")
api = status.get("API_URL")
db = status.get("DB_URL")
p = pathlib.Path(".env.local")
text = p.read_text()
if anon:
	text = re.sub(r"(?m)^SUPABASE_PUBLISHABLE_KEY=.*$", f"SUPABASE_PUBLISHABLE_KEY={anon}", text)
if service:
	text = re.sub(r"(?m)^SUPABASE_SECRET_KEY=.*$", f"SUPABASE_SECRET_KEY={service}", text)
if api:
	text = re.sub(r"(?m)^SUPABASE_URL=.*$", f"SUPABASE_URL={api}", text)
if db:
	text = re.sub(r"(?m)^DATABASE_URL=.*$", f"DATABASE_URL={db}", text)
# Prefer Mailpit for local email.
text = re.sub(r"(?m)^EMAIL_SMTP_HOST=.*$", "EMAIL_SMTP_HOST=localhost", text)
p.write_text(text)
print("cloud-start: synced supabase keys into .env.local")
PY
}

ensure_supabase() {
	if [[ ! -d node_modules/.bin ]]; then
		log "WARN: node_modules missing; skip db:start (install should have run npm ci)" >&2
		return 0
	fi

	log "ensuring local Supabase (npm run db:start)"
	npm run db:start
	sync_supabase_keys_into_env

	# First boot / empty DB: generate seed + reset once when doctor fails.
	if npm run db:doctor >/tmp/db-doctor.out 2>&1; then
		log "db:doctor ok"
		return 0
	fi

	log "db:doctor failed — generating seed and resetting local DB once"
	npm run db:generate-seed
	npm run db:reset
	sync_supabase_keys_into_env
	npm run db:doctor
	log "database ready"
}

main() {
	ensure_dockerd
	ensure_supabase
	log "done"
}

main "$@"
