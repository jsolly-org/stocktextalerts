# Deploy gotchas

## Merge to main before SAM deploy that changes env vars

A feature-branch SAM deploy can remove env vars (e.g., a stale `RESEND_API_KEY`) before the PR that introduces the replacement env var (`SES_*`) lands on main. The Lambda picks up the partial env immediately and starts crashing on the missing value.

**Rule:** any PR that adds, removes, or renames a Lambda env var must merge to `main` first. Only then run `cd aws && npm run deploy:infra`. The post-push code deploy (`npm run deploy:code` → `aws/deploy-web.sh`) calls `gate_require_landed` and only ever builds `origin/main`'s landed HEAD, so it sees the full env-var set; the rule still applies to manual feature-branch `npm run deploy:infra` runs.

For the approval-admin allowlist rename, the safe sequence is:

1. Add `ADMIN_EMAILS` to Vercel for every environment that should expose `/admin/users`.
2. Remove the old `APPROVAL_ADMIN_EMAILS` variable after the new variable is present.
3. Merge to `main`.
4. Run `npm run deploy:infra` so the email-dispatch Lambda receives the matching `ADMIN_EMAILS` env var.

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

## Destructive migrations must be expand-contract (split across two deploys)

`aws/deploy-web.sh` runs **Phase 2 (Supabase `db push`) before Phase 3 (Lambda `update-function-code`)**. The migration is one-way; the code update is not atomic with it. So if a destructive migration (DROP/RENAME a column) and the code that stops reading that column ship in the **same commit**, there is a window — from Phase 2 completing until Phase 3 finishes — where prod's schema is migrated but the still-running Lambda holds the old code. Any Phase-3 abort (a bundle build break, an AWS hiccup, an expired SSO token) strands prod in that state, and the every-minute `schedule` cron fails on the missing column until a redeploy.

This bit on 2026-06-21: migration `20260619233608_drop_per_option_include_columns` applied, then the deploy aborted on a `@resvg/resvg-js` bundle build break before the schedule Lambda's code updated → ~18 min of `column ... does not exist` and failed scheduled-notification passes (recovered by temporarily re-adding the column, fixing the build, and redeploying). Building the bundle Phase-1-first closed the *build-break* trigger, but not the general "Phase 3 fails after Phase 2" class.

**Rule:** never drop or rename a column in the same commit that removes the code reading it. Expand-contract across two deploys:

1. **Expand** — ship code that tolerates *both* the old and new schema (read from the new shape, ignore the old column). Deploy.
2. **Contract** — in a *later* commit, drop/rename the column. Deploy.

Now a Phase-3 failure on either deploy is harmless: the running code already doesn't depend on the column being present-or-absent. `npm run check:deploy-drift` audits the inverse failure (a deploy that didn't fire, leaving live Lambdas behind `origin/main`).

## Explicit CloudWatch `AlarmName` may replace alarms on deploy

SAM updates that add `AlarmName` to previously auto-named alarms can replace the underlying CloudWatch alarm resource. You may get a one-off state transition email during deploy. See [docs/shared-infra.md](shared-infra.md).

## Live provider health-check alerts use shared-infra

The scheduled `stocktextalerts-live-provider-check` Lambda (weekday mid-session) throws when a live Massive/Finnhub round-trip fails. Its `AWS/Lambda Errors` metric trips `stocktextalerts-live-provider-check-lambda-errors`, whose alarm action publishes **directly** to the shared-infra SNS topic (`/shared-infra/alert-topic-arn`) — the enricher Lambda sends the usual SES email.

No extra IAM is needed: CloudWatch publishes to the topic via the alarm action.
