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
