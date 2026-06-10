#!/usr/bin/env bash
# Detect "main ahead of prod" drift: if a commit touching deployable Lambda
# paths landed on main and the deployed function was NOT updated afterwards
# (pre-push gate skipped, server-side merge, etc.), publish an alert to the
# shared-infra topic. Runs under the scoped agent-deploy role — read-only
# Lambda config + SNS publish, no new permissions.
#
# GIT_SHA env-var equality can't be used here: code-only deploys
# (update-function-code) cannot touch env vars, so GIT_SHA only reflects the
# last full SAM deploy by design.
set -euo pipefail

FUNCTION_NAME="stocktextalerts-schedule"
# Paths that feed the deployed Lambda bundles (see aws/deploy-web.sh).
DEPLOY_PATHS=(aws/src src/lib package.json package-lock.json)
GRACE_SECONDS=$((2 * 3600)) # allow for in-flight pushes around the cron

commit_iso=$(git log -1 --format=%cI -- "${DEPLOY_PATHS[@]}")
lastmod_iso=$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --query 'LastModified' --output text)

iso_to_epoch() {
  # Portable across GNU/BSD: Lambda's LastModified uses +0000 (no colon).
  python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("+0000", "+00:00")).timestamp()))' "$1"
}
commit_epoch=$(iso_to_epoch "$commit_iso")
lastmod_epoch=$(iso_to_epoch "$lastmod_iso")

if ((commit_epoch > lastmod_epoch + GRACE_SECONDS)); then
  echo "DRIFT: main has deployable changes ($commit_iso) newer than the deployed Lambda ($lastmod_iso)"
  TOPIC_ARN=$(aws ssm get-parameter --name /shared-infra/alert-topic-arn \
    --query 'Parameter.Value' --output text)
  aws sns publish --topic-arn "$TOPIC_ARN" --message "{
    \"AlarmName\": \"stocktextalerts-deploy-drift\",
    \"NewStateValue\": \"ALARM\",
    \"NewStateReason\": \"main has deployable commits (latest: ${commit_iso}) newer than the deployed ${FUNCTION_NAME} Lambda (last updated: ${lastmod_iso}). A push likely skipped the pre-push gate or merged server-side. Run npm run deploy locally.\"
  }" >/dev/null
  exit 1
fi
echo "No drift: deployed Lambda ($lastmod_iso) is current with main ($commit_iso)"
