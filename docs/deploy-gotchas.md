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
