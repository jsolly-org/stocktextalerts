#!/usr/bin/env bash
# CI-only: install node_modules, skipping `npm ci` when the sticky disk already
# holds the tree this lockfile produces.
#
# .github/workflows/ci.yml mounts a Blacksmith sticky disk at <workspace>/node_modules
# before this runs. The disk key is deliberately NOT hashed on package-lock.json
# (same rationale as the Playwright browser disk: a hashed key hands every
# dependency bump an empty disk), so the disk can legitimately hold an older
# install, and the stamp below is what makes the reuse safe. `npm ci` still wipes and
# rebuilds the tree on any mismatch, so a hit is exactly the tree `npm ci` would
# have produced, and a miss costs only the stamp read.
#
# Usage: bash scripts/ci-npm-install.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="node_modules/.ci-lock-hash"
LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"

# `.bin/tsx` guards against a truncated disk (an interrupted install commits a
# tree with no stamp, but check a real entrypoint too rather than trust the file).
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$LOCK_HASH" ] && [ -x node_modules/.bin/tsx ]; then
	echo "node_modules: sticky-disk hit for lockfile ${LOCK_HASH:0:12}, skipping npm ci"
	exit 0
fi

echo "node_modules: sticky-disk miss for lockfile ${LOCK_HASH:0:12}, running npm ci"
npm ci
printf '%s\n' "$LOCK_HASH" >"$STAMP"
