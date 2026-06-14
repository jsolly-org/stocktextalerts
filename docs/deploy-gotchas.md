# Deploy gotchas

## Merge to main before SAM deploy that changes env vars

A feature-branch SAM deploy can remove env vars (e.g., a stale `RESEND_API_KEY`) before the PR that introduces the replacement env var (`SES_*`) lands on main. The Lambda picks up the partial env immediately and starts crashing on the missing value.

**Rule:** any PR that adds, removes, or renames a Lambda env var must merge to `main` first. Only then run `cd aws && npm run deploy`. The pre-push deploy (`aws/deploy-web.sh`) builds the commit being pushed to `main`, so it sees the full env-var set; the rule still applies to manual feature-branch `npm run deploy:aws` runs.

For the approval-admin allowlist rename, the safe sequence is:

1. Add `ADMIN_EMAILS` to Vercel for every environment that should expose `/admin/users`.
2. Remove the old `APPROVAL_ADMIN_EMAILS` variable after the new variable is present.
3. Merge to `main`.
4. Run `npm run deploy:aws` so the email-dispatch Lambda receives the matching `ADMIN_EMAILS` env var.

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

## Explicit CloudWatch `AlarmName` may replace alarms on deploy

SAM updates that add `AlarmName` to previously auto-named alarms can replace the underlying CloudWatch alarm resource. You may get a one-off state transition email during deploy. See [docs/shared-infra.md](shared-infra.md).

## Live provider health-check alerts use shared-infra

The scheduled `stocktextalerts-live-provider-check` Lambda (weekday mid-session) throws when a live Massive/Finnhub round-trip fails. Its `AWS/Lambda Errors` metric trips `stocktextalerts-live-provider-check-lambda-errors`, whose alarm action publishes **directly** to the shared-infra SNS topic (`/shared-infra/alert-topic-arn`) — the enricher Lambda sends the usual SES email.

No extra IAM is needed: CloudWatch publishes to the topic via the alarm action.

**TODO (manual AWS cleanup):** the `agent-deploy` role's `stocktextalerts-shared-infra-publish` inline policy was added for the GitHub Actions OIDC publish path, which has since been removed (no `.github/workflows/` remain), so the policy is obsolete. `agent-deploy` is a manually-managed IAM role — not SAM-managed and not in this repo's IaC — so it can't be cleaned up by a deploy. Remove it by hand once confirmed unused:

```bash
aws iam list-role-policies --role-name agent-deploy   # confirm it's still attached
aws iam delete-role-policy --role-name agent-deploy --policy-name stocktextalerts-shared-infra-publish
```
