# Deploy gotchas

## Merge to main before SAM deploy that changes env vars

A feature-branch SAM deploy can remove env vars (e.g., a stale `RESEND_API_KEY`) before the PR that introduces the replacement env var (`SES_*`) lands on main. The Lambda picks up the partial env immediately and starts crashing on the missing value.

**Rule:** any PR that adds, removes, or renames a Lambda env var must merge to `main` first. Only then run `cd aws && npm run deploy`. CI's `Deploy Website` workflow runs from `main`, so it sees the full env-var set.

See [docs/incidents/2026-03-resend-ses-migration.md](incidents/2026-03-resend-ses-migration.md) for the outage that motivated this.

## SAM `--parameter-overrides` shorthand mangles whitespace

`sam deploy --parameter-overrides KEY=VALUE` re-splits each argv on whitespace regardless of shell quoting. A value like `StockTextAlerts <notifications@stocktextalerts.com>` reaches CloudFormation as just `StockTextAlerts`.

**Rule:** any CloudFormation parameter whose value can contain whitespace must be SSM-backed:

```yaml
EmailFrom:
  Type: AWS::SSM::Parameter::Value<String>
  Default: /stocktextalerts/email-from
```

Set the actual value once via `aws ssm put-parameter`. CloudFormation resolves it at deploy time without going through the CLI argv layer. Same pattern as `AlertTopicArn`.

See [docs/incidents/2026-05-email-from-mangling.md](incidents/2026-05-email-from-mangling.md) for the outage that motivated this.

## Live provider CI alerts use alert-hub

`.github/workflows/live-provider-tests.yml` publishes a synthetic CloudWatch alarm JSON to the shared alert-hub SNS topic (`/alert-hub/alert-topic-arn` in SSM) on first failure in a streak. The enricher Lambda sends the usual SES email.

`GitHubActionsDeploymentRole` must allow reading that SSM parameter and publishing to the topic. One-time attach (adjust if the topic ARN changes):

```bash
TOPIC_ARN="$(aws ssm get-parameter --name /alert-hub/alert-topic-arn --query Parameter.Value --output text --profile prod-admin)"
aws iam put-role-policy \
  --role-name GitHubActionsDeploymentRole \
  --policy-name stocktextalerts-alert-hub-publish \
  --policy-document "$(jq -n --arg topic "$TOPIC_ARN" '{
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: "arn:aws:ssm:us-east-1:730335616323:parameter/alert-hub/alert-topic-arn"
      },
      {
        Effect: "Allow",
        Action: "sns:Publish",
        Resource: $topic
      }
    ]
  }')" \
  --profile prod-admin
```
