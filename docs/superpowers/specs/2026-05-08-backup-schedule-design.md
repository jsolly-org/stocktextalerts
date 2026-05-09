# Scheduled off-platform database backups

**Status:** Design

**Date:** 2026-05-08

## Summary

Add a daily scheduled logical backup of the production Supabase Postgres database to an S3 bucket the project owns, plus a weekly automated restore-verification workflow. Closes a real gap: the project is on Supabase Free, which has zero built-in backups (confirmed via the Supabase MCP — org `SollyProjects` is on `plan: "free"`).

Two new GitHub Actions workflows, one new S3 bucket in the existing CloudFormation stack, an inline IAM policy on the existing `GitHubActionsDeploymentRole`, and a written restore runbook. No new Lambdas, no new infra patterns, no recurring SaaS cost.

**RPO target:** ~24 hours. **Retention:** 30 days hot in S3 STANDARD, then auto-tiered to Glacier Instant Retrieval through day 365, then expire.

## Motivation

The Supabase Free tier provides no automatic database backups. Supabase's own documentation explicitly recommends free-tier projects "regularly export their data using the Supabase CLI `db dump` command and maintain off-site backups." Today, a Supabase outage that affected `japesagairjvvuebzpvr` data — accidental project deletion via the dashboard, account compromise, regional incident, schema corruption from a bad migration — would result in unrecoverable data loss for every signed-up user, every tracked asset, and every staged notification.

The data lost is not catastrophic in dollar terms (no payments, no irreplaceable user-generated content), but it is genuinely lost: there's no upstream system we could re-derive `users`, `user_assets`, or notification preferences from. Re-onboarding every user is the only fallback, and for an SMS-based product where users had to verify a phone number, that's a near-total churn event.

This work also unlocks lower-stakes value: schema-only or table-scoped restores into a local Postgres make it possible to investigate "what did this row look like 3 weeks ago" questions, and to test destructive migrations against a recent prod snapshot.

## Non-goals

- **Storage object backups.** `supabase.storage` is not used in the app (`grep -r "supabase.storage" src/` returns nothing). If/when storage is adopted, a separate storage-backup workflow is the right pattern.
- **Edge-function source backups.** Edge functions live in git already.
- **Sub-daily RPO.** Hourly dumps would work but aren't justified for the data being protected. Revisit if user-impacting state churn rate increases substantially.
- **Point-in-Time Recovery.** PITR requires the Supabase Pro plan and a paid compute add-on. Not in scope.
- **Encrypted-at-rest dumps with a customer-managed key.** SSE-S3 is sufficient. KMS adds cost (~$1/mo per key plus per-request charges) without buying meaningful protection against the threats this design covers.
- **Cross-region or cross-account replication of the backup bucket.** A second copy in another region/account is a reasonable belt-and-suspenders v2; not v1.
- **A `BackupFunction` Lambda or container image.** Considered and rejected during brainstorming — see "Alternatives considered."
- **Pager / SMS escalation for backup failures.** GitHub email on workflow failure is the v1 alerting channel.

## Architecture overview

```
┌─ Daily backup (.github/workflows/db-backup.yml) ──────────────────┐
│  cron: 06:00 UTC                                                  │
│  workflow_dispatch: enabled                                       │
│  ─────────────────────────────────────────────────────────────    │
│  install supabase CLI (setup-cli@v2)                              │
│  configure-aws-credentials@v6.0.0 (OIDC →                         │
│    arn:aws:iam::730335616323:role/GitHubActionsDeploymentRole)    │
│  ─────────────────────────────────────────────────────────────    │
│  supabase db dump --role-only       > roles.sql                   │
│  supabase db dump                   > schema.sql                  │
│  supabase db dump --data-only --use-copy | gzip > data.sql.gz     │
│  write manifest.json (sha256s, sizes, timestamp, git sha)         │
│  ─────────────────────────────────────────────────────────────    │
│  aws s3 cp ./{roles.sql,schema.sql,data.sql.gz,manifest.json} \\  │
│    s3://stocktextalerts-db-backups/YYYY/MM/DD/                    │
│  manifest.json uploaded LAST → its presence = "this prefix is     │
│    complete and trustworthy"                                      │
└───────────────────────────────────────────────────────────────────┘

┌─ Weekly restore verification (.github/workflows/db-backup-verify.yml) ─┐
│  cron: Mon 07:00 UTC (1 hr after Sunday's backup)                      │
│  workflow_dispatch: enabled                                            │
│  ──────────────────────────────────────────────────────────────────    │
│  configure-aws-credentials (same OIDC role)                            │
│  find latest YYYY/MM/DD/ prefix containing manifest.json               │
│  fail if newest manifest is > 8 days old (silent-skip canary)          │
│  download all four files                                               │
│  verify sha256s vs. manifest.json                                      │
│  ──────────────────────────────────────────────────────────────────    │
│  spin up postgres:17-alpine service container                          │
│  psql -f roles.sql                                                     │
│  psql -f schema.sql                                                    │
│  gunzip -c data.sql.gz | psql                                          │
│  ──────────────────────────────────────────────────────────────────    │
│  assert: row counts > 0 on users, assets, user_assets,                 │
│          staged_notifications                                          │
│  exit 0 = green; exit 1 = workflow failure → GitHub email              │
└────────────────────────────────────────────────────────────────────────┘

┌─ S3 bucket (us-east-1, in aws/template.yaml) ─────────────────────┐
│  Name: stocktextalerts-db-backups                                 │
│  Region: us-east-1 (consolidates with existing SAM stack)         │
│  Encryption: SSE-S3                                               │
│  Public access: fully blocked                                     │
│  Versioning: off                                                  │
│  Lifecycle:                                                       │
│    day 0–30   STANDARD                                            │
│    day 31–365 GLACIER_IR (Instant Retrieval)                      │
│    day 366    expire                                              │
└───────────────────────────────────────────────────────────────────┘

┌─ IAM ─────────────────────────────────────────────────────────────┐
│  Inline policy on existing GitHubActionsDeploymentRole:           │
│    s3:PutObject, s3:GetObject, s3:ListBucket                      │
│    Resource scoped to this bucket only                            │
│  No new role created.                                             │
└───────────────────────────────────────────────────────────────────┘
```

## Components

### `.github/workflows/db-backup.yml`

Triggers: `schedule: cron: "0 6 * * *"` and `workflow_dispatch`.

Runs on `ubuntu-latest`. Permissions: `id-token: write` (OIDC), `contents: read`.

Steps in order:

1. `actions/checkout@v4` — needed to read the Supabase CLI version pin and any helper scripts.
2. `supabase/setup-cli@v2` — installs the same CLI version `deploy.yml` already uses.
3. `aws-actions/configure-aws-credentials@v6.0.0` with `role-to-assume: arn:aws:iam::730335616323:role/GitHubActionsDeploymentRole`, `aws-region: us-east-1`.
4. `echo "::add-mask::${{ secrets.DATABASE_URL_PROD }}"` to keep the DSN out of logs.
5. Bash step with `set -euo pipefail`:
   ```bash
   d=$(date -u +%Y/%m/%d)
   supabase db dump --db-url "$DATABASE_URL_PROD" --role-only > roles.sql
   supabase db dump --db-url "$DATABASE_URL_PROD"             > schema.sql
   supabase db dump --db-url "$DATABASE_URL_PROD" --data-only --use-copy | gzip > data.sql.gz

   jq -n \
     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     --arg sha "$GITHUB_SHA" \
     --arg roles_sha "$(sha256sum roles.sql | cut -d' ' -f1)" \
     --arg schema_sha "$(sha256sum schema.sql | cut -d' ' -f1)" \
     --arg data_sha "$(sha256sum data.sql.gz | cut -d' ' -f1)" \
     --argjson roles_size "$(stat -c %s roles.sql)" \
     --argjson schema_size "$(stat -c %s schema.sql)" \
     --argjson data_size "$(stat -c %s data.sql.gz)" \
     '{timestamp: $ts, git_sha: $sha,
       files: {
         "roles.sql":   {sha256: $roles_sha,  size: $roles_size},
         "schema.sql":  {sha256: $schema_sha, size: $schema_size},
         "data.sql.gz": {sha256: $data_sha,   size: $data_size}
       }}' > manifest.json

   aws s3 cp roles.sql     "s3://stocktextalerts-db-backups/$d/roles.sql"
   aws s3 cp schema.sql    "s3://stocktextalerts-db-backups/$d/schema.sql"
   aws s3 cp data.sql.gz   "s3://stocktextalerts-db-backups/$d/data.sql.gz"
   aws s3 cp manifest.json "s3://stocktextalerts-db-backups/$d/manifest.json"
   ```

   `manifest.json` is uploaded last on purpose. Its presence under a date prefix is the unambiguous "this prefix is complete" signal for the verify workflow.

### `.github/workflows/db-backup-verify.yml`

Triggers: `schedule: cron: "0 7 * * 1"` (Monday 07:00 UTC) and `workflow_dispatch`.

Runs on `ubuntu-latest`. Same permissions as backup workflow. Service container: `postgres:17-alpine`.

Steps:

1. `aws-actions/configure-aws-credentials@v6.0.0` (same role).
2. Find the latest manifest:
   ```bash
   latest=$(aws s3api list-objects-v2 \
     --bucket stocktextalerts-db-backups \
     --query 'reverse(sort_by(Contents[?ends_with(Key, `manifest.json`)], &LastModified))[0].Key' \
     --output text)
   prefix="$(dirname "$latest")"
   ```
3. Canary check: fail the workflow if the latest manifest's `LastModified` is more than 8 days ago. This catches "the daily backup workflow stopped firing" with up to a week of latency. (The 8-day threshold leaves headroom for one missed daily run before alerting.)
4. Download the four files from `$prefix/`.
5. Verify sha256 of each file matches the manifest. Fail on mismatch.
6. Restore:
   ```bash
   PGPASSWORD=postgres psql -h localhost -U postgres -d postgres -f roles.sql
   PGPASSWORD=postgres psql -h localhost -U postgres -d postgres -f schema.sql
   gunzip -c data.sql.gz | PGPASSWORD=postgres psql -h localhost -U postgres -d postgres
   ```
7. Assert critical tables are non-empty:
   ```sql
   select case when count(*) > 0 then 1 else 1/0 end from public.users;
   select case when count(*) > 0 then 1 else 1/0 end from public.assets;
   select case when count(*) > 0 then 1 else 1/0 end from public.user_assets;
   select case when count(*) > 0 then 1 else 1/0 end from public.staged_notifications;
   ```
   Division-by-zero on empty result raises a SQL error → `psql` exits non-zero → workflow fails.

### S3 bucket — `aws/template.yaml`

Add to `Resources`:

```yaml
BackupBucket:
  Type: AWS::S3::Bucket
  DeletionPolicy: Retain
  UpdateReplacePolicy: Retain
  Properties:
    BucketName: stocktextalerts-db-backups
    PublicAccessBlockConfiguration:
      BlockPublicAcls: true
      BlockPublicPolicy: true
      IgnorePublicAcls: true
      RestrictPublicBuckets: true
    BucketEncryption:
      ServerSideEncryptionConfiguration:
        - ServerSideEncryptionByDefault:
            SSEAlgorithm: AES256
    LifecycleConfiguration:
      Rules:
        - Id: tier-then-expire
          Status: Enabled
          Transitions:
            - StorageClass: GLACIER_IR
              TransitionInDays: 31
          ExpirationInDays: 366
```

`DeletionPolicy: Retain` is non-negotiable here — a `cloudformation delete-stack` accident must not also drop a year of backups.

### IAM

Inline policy attached to the existing `GitHubActionsDeploymentRole` (defined outside this stack — added via the AWS console or a small bootstrap script, since the role itself isn't managed by this template):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::stocktextalerts-db-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::stocktextalerts-db-backups"
    }
  ]
}
```

No `s3:DeleteObject` — lifecycle rules handle deletion; the workflow has no business deleting backups directly.

### Restore runbook — `docs/runbooks/db-restore.md`

Three documented restore paths. Each is written as exact commands (not prose), assuming the operator has `psql`, `aws-cli`, `docker`, and AWS profile `prod-admin` available.

1. **Disaster recovery** (Supabase project gone). Provision a new Supabase project; download the most recent dump from S3; apply roles → schema → data into the new project; rotate `DATABASE_URL_PROD`, `SUPABASE_URL_PROD`, and `SUPABASE_SECRET_KEY_PROD` in (a) `.env.local`, (b) Vercel env, (c) GitHub repo secrets, (d) AWS SSM parameters consumed by SAM.
2. **Targeted recovery into a local DB** ("what did `users.timezone` look like for user X 5 days ago"). Pick the date prefix; download just `data.sql.gz`; restore into `postgres:17-alpine` locally; query.
3. **Schema diff against a past day**. Download just `schema.sql` from the chosen day; `diff` against the current `supabase db dump --db-url ...`.

The runbook is part of v1, not a follow-up. An untested restore is approximately the same as no backup, and the verify workflow only proves *that* the dump restores — not that a human can navigate the rotation steps.

## Data flow

See "Architecture overview" for the diagrammed flow. Key invariants:

- **Atomic prefix.** `manifest.json` is the last file uploaded; its presence indicates "this prefix is complete."
- **No in-place updates.** Every dump lives at `YYYY/MM/DD/` — there is never an "overwrite the previous backup" path. Re-running the workflow on the same day overwrites that day's files (idempotent for retries within a day).
- **Date partitioning is in UTC**, matching the cron schedule's UTC interpretation, so the prefix unambiguously identifies the run.

## Error handling

### Backup workflow failures

| Failure mode             | Detection                            | Operator signal                  |
|--------------------------|--------------------------------------|----------------------------------|
| Dump command fails       | `set -euo pipefail` exits non-zero   | GitHub workflow-failure email    |
| Upload fails             | Same                                 | Same                             |
| Partial upload           | `manifest.json` not written          | Verify workflow ignores prefix; surfaces "no recent backup" within 8 days |
| Schedule silently skipped| Verify canary: latest manifest > 8d  | Verify workflow fails → GH email |

`DATABASE_URL_PROD` is masked in step output via `::add-mask::` to prevent secrets leaking into public Actions logs (the repo is private, but defense in depth).

### Verify workflow failures

| Failure mode             | Detection                            | Operator signal                  |
|--------------------------|--------------------------------------|----------------------------------|
| No backup found          | `aws s3api list-objects-v2` empty    | GH email                         |
| Latest backup too old    | Manifest `LastModified` > 8d ago     | GH email                         |
| sha256 mismatch          | Bash compare against manifest        | GH email                         |
| Restore errors           | psql exits non-zero                  | GH email + workflow logs         |
| Empty critical table     | SQL division-by-zero raises error    | GH email                         |

A verify failure is high-priority — it implies either the backup is corrupt, the dump command is silently dropping data, or a schema change broke the restore path.

### Out of scope at v1

- **CloudWatch heartbeat metric.** A v2 improvement: `aws cloudwatch put-metric-data` from the workflow's success step, plus a "no datapoints for 36h" alarm wired into the existing alert-hub SNS topic. Provides faster silent-skip detection (~36h vs. ~1 week) but adds a moving part. Defer until verify-canary proves insufficient in practice.
- **Bucket cross-region replication.** v2 if the threat model includes "us-east-1 is gone for an extended period."
- **gpg client-side encryption of dumps.** SSE-S3 covers the at-rest threat. Adding gpg means key management becomes part of the restore process, which is a worse trade for this product's threat model.

## Alternatives considered

**AWS Lambda + EventBridge Scheduler.** Considered because it matches the existing `ScheduleFunction` / `ComputeDailyStatsFunction` patterns and would route errors through alert-hub uniformly. Rejected: `pg_dump` isn't in the standard Node Lambda runtime, so it requires a container image — meaningfully heavier than the rest of the stack (which is plain esbuild Lambdas). Restore verification is also awkward in Lambda (no Docker), and verification is the actually-valuable piece. Unified alerting is real but doesn't outweigh the maintenance overhead.

**Hosted backup SaaS** (Ottomatik, pgbackweb, etc.). Rejected: $5–15/mo recurring on a free-tier project, third-party with prod DB credentials, doesn't fit the "I own all of this" posture of the rest of the stack.

**One combined workflow** (backup + verify in the same run). Rejected: verify-after-backup hides the silent-skip case (if backup never runs, neither does verify, so neither alerts). Separating them with the canary check is what makes "backups stopped firing" detectable.

**Bucket in us-east-2** (matching the Supabase DB region). Rejected during design walkthrough: cross-region transfer cost on a small DB is negligible, and consolidating all AWS resources in us-east-1 is operationally simpler.

**Versioned bucket** instead of date-partitioned keys. Rejected: versioning would multiply storage cost without adding recovery capability — each daily dump is already a separate object.

## Implementation notes / pre-merge checklist

- The IAM inline policy is added once, manually, before the workflows can run. The workflow PR includes this as a one-line operator action in the PR description, not as Terraform/CFN, because `GitHubActionsDeploymentRole` predates this stack and lives outside SAM.
- `DATABASE_URL_PROD` is already in repo secrets (used by `db push` in `deploy.yml`).
- Local sanity-check the dump-and-restore pipeline once against the real prod DB before opening the PR (commands documented in the runbook). A workflow that's only ever been exercised in CI is an unproven workflow on day one.
- After merge, manually trigger both workflows once (via `workflow_dispatch`) and confirm: a dated prefix appears in S3 with all four files; verify completes green.
- Cost expectation: well under $1/month at current data volumes.

## Open questions

None for v1. v2 candidates (CloudWatch heartbeat, cross-region replication, gpg encryption) are explicitly deferred and tracked in the runbook's "future improvements" section, not blocking this work.
