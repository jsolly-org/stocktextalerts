#!/usr/bin/env bash
# Publish a synthetic CloudWatch alarm to the alert-hub SNS topic so the
# enricher delivers a formatted email (same path as Lambda alarms).
set -euo pipefail

: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

AWS_REGION="${AWS_REGION:-us-east-1}"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
STATE_CHANGE_TIME="$(date -u +"%Y-%m-%dT%H:%M:%S.000+0000")"

TOPIC_ARN="$(aws ssm get-parameter \
  --name /alert-hub/alert-topic-arn \
  --query Parameter.Value \
  --output text \
  --region "$AWS_REGION")"

MESSAGE="$(jq -n \
  --arg reason "Live Provider API Tests failed in GitHub Actions. Run: ${RUN_URL}" \
  --arg time "$STATE_CHANGE_TIME" \
  '{
    AlarmName: "stocktextalerts-live-provider-tests",
    AlarmDescription: "Scheduled live Massive/Finnhub API tests failed in GitHub Actions",
    AWSAccountId: "730335616323",
    NewStateValue: "ALARM",
    OldStateValue: "OK",
    NewStateReason: $reason,
    StateChangeTime: $time,
    Region: "US East (N. Virginia)",
    AlarmArn: "arn:aws:cloudwatch:us-east-1:730335616323:alarm:stocktextalerts-live-provider-tests",
    Trigger: {
      MetricName: "Failed",
      Namespace: "stocktextalerts-ci",
      Statistic: "SUM",
      Period: 86400,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 1,
      TreatMissingData: "notBreaching"
    }
  }')"

aws sns publish \
  --topic-arn "$TOPIC_ARN" \
  --message "$MESSAGE" \
  --region "$AWS_REGION"
