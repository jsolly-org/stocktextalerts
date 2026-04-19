#!/usr/bin/env bash
set -euo pipefail

WORKFLOW=".github/workflows/noDeploy.yml"
EVENT="pull_request"
JOB=""
SECRETS_FILE=".act.secrets"
VERBOSE=0

usage() {
  cat <<'EOF'
Run GitHub Actions locally with act.

Usage:
  scripts/ci/run-local-actions.sh [options]

Options:
  --job <name>         Run a single job (example: lint, test-and-build)
  --workflow <path>    Workflow file to run (default: .github/workflows/noDeploy.yml)
  --event <name>       Event name (default: pull_request)
  --verbose            Enable verbose act output
  -h, --help           Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --job requires an argument" >&2
        exit 1
      fi
      JOB="${2:-}"
      shift 2
      ;;
    --workflow)
      WORKFLOW="${2:-}"
      shift 2
      ;;
    --event)
      EVENT="${2:-}"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v act >/dev/null 2>&1; then
  echo "Error: act is not installed. Install with 'brew install act'." >&2
  exit 1
fi

if [[ ! -f "$WORKFLOW" ]]; then
  echo "Error: Workflow file not found: $WORKFLOW" >&2
  exit 1
fi

# deploy.yml is intentionally not reproducible with act: it talks to Supabase,
# Vercel, and AWS with production credentials. Fail fast instead of leaking
# half-run production side effects.
if [[ "$(basename "$WORKFLOW")" == "deploy.yml" ]]; then
  cat >&2 <<'EOF'
Error: .github/workflows/deploy.yml cannot be run locally with act.

deploy.yml links the live Supabase project, pushes migrations, deploys to
Vercel, and updates Lambda code with real credentials. Running it locally
would hit production.

To reproduce the CI parts of deploy.yml without credentials, run:
  npm run gha:local:test-build   # runs the same run-ci composite action
  npm run gha:local:e2e          # reproduces the E2E workflow job under act
EOF
  exit 1
fi

# Podman VM preflight: a too-small VM causes Vitest to be OOM-killed inside
# the act container, and stale act-* containers from prior runs keep the VM
# under memory pressure for the next one. Both fail loudly with SIGKILL but
# without any test-level error, which was the exact failure we chased on
# 2026-04-19 (see AGENTS.md "Reproduce CI locally with Act").
MIN_PODMAN_MEMORY_MB=6144
PODMAN_MACHINE_NAME="podman-machine-default"

if command -v podman >/dev/null 2>&1; then
  podman_memory_mb="$(podman machine inspect "$PODMAN_MACHINE_NAME" \
    --format '{{.Resources.Memory}}' 2>/dev/null || true)"
  if [[ -n "$podman_memory_mb" && "$podman_memory_mb" =~ ^[0-9]+$ ]] \
    && (( podman_memory_mb < MIN_PODMAN_MEMORY_MB )); then
    cat >&2 <<EOF
Error: Podman VM "$PODMAN_MACHINE_NAME" has ${podman_memory_mb} MB of memory,
but local \`act\` runs need at least ${MIN_PODMAN_MEMORY_MB} MB. Under this
threshold the VM OOM-kills Vitest mid-run and reports only SIGKILL, with no
test-level failure.

Fix it once (persists across reboots):
  podman machine stop $PODMAN_MACHINE_NAME
  podman machine set --memory $MIN_PODMAN_MEMORY_MB $PODMAN_MACHINE_NAME
  podman machine start $PODMAN_MACHINE_NAME
EOF
    exit 1
  fi

  stale_act_containers="$(podman ps -a --filter name=act- \
    --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$stale_act_containers" ]]; then
    echo "Removing stale act-* containers to free VM memory..."
    xargs podman rm -f <<<"$stale_act_containers" >/dev/null 2>&1 || true
  fi
fi

mkdir -p .tmp
EVENT_FILE=".tmp/act-event-${EVENT}.json"
HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$HEAD_SHA"

if git show-ref --verify --quiet refs/remotes/origin/main; then
  MERGE_BASE="$(git merge-base HEAD refs/remotes/origin/main || true)"
  if [[ -n "$MERGE_BASE" ]]; then
    BASE_SHA="$MERGE_BASE"
  fi
fi

cat > "$EVENT_FILE" <<EOF
{
  "pull_request": {
    "base": { "sha": "$BASE_SHA", "ref": "main" },
    "head": { "sha": "$HEAD_SHA", "ref": "local-act" }
  },
  "repository": {
    "full_name": "local/stocktextalerts",
    "default_branch": "main"
  }
}
EOF

ACT_ARGS=("$EVENT" "-W" "$WORKFLOW" "--eventpath" "$EVENT_FILE" "--env" "CI=true")
if [[ -n "$JOB" ]]; then
  ACT_ARGS+=("-j" "$JOB")
fi
if [[ -f "$SECRETS_FILE" ]]; then
  ACT_ARGS+=("--secret-file" "$SECRETS_FILE")
fi
if [[ "$VERBOSE" -eq 1 ]]; then
  ACT_ARGS+=("-v")
fi

echo "Running: act ${ACT_ARGS[*]}"
act "${ACT_ARGS[@]}"
