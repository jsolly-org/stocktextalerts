#!/usr/bin/env bash
# Retry an npm script ONLY on transient container-registry throttle.
# Shared by scripts/db/ci-bootstrap.sh (db:start + db:reset) so the classifier
# can never silently diverge (see .github/workflows/ci.yml).
#
# Usage: bash scripts/db/ci-db-retry.sh <npm-script> <log-file>
# Requires TRANSIENT_REGEX in the environment.
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
	echo "Usage: $0 <npm-script> <log-file>" >&2
	exit 2
fi

script="$1"
log_file="$2"

if [ -z "${TRANSIENT_REGEX:-}" ]; then
	echo "::error::TRANSIENT_REGEX is unset — refusing to retry without a classifier." >&2
	exit 2
fi

for attempt in 1 2 3; do
	if npm run "$script" 2>&1 | tee "$log_file"; then
		exit 0
	fi
	if ! grep -qiE "$TRANSIENT_REGEX" "$log_file"; then
		echo "::error::${script} failed for a non-transient reason (see log above); not retrying." >&2
		exit 1
	fi
	if [ "$attempt" -lt 3 ]; then
		echo "::warning::${script} hit a transient registry throttle (attempt ${attempt}/3); retrying in $((attempt * 30))s." >&2
		sleep "$((attempt * 30))"
	fi
done

echo "::error::${script} still throttled by the container registry after 3 attempts." >&2
exit 1
