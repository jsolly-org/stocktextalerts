# User-Settings Backups

Backs up 4 user-authored tables (`users`, `user_assets`, `price_targets`,
`scheduled_notifications`) 5×/day to the existing private S3 bucket
`stocktextalerts-prod-backups-<acct>` under the `user-settings/` prefix.
Design: `docs/superpowers/specs/2026-06-13-user-settings-backup-design.md`.

## One-time setup (human only — never via an agent)

1. Set the role password against production (human runbook; not in committed SQL):
   `ALTER ROLE backup_readonly LOGIN PASSWORD '<generated>';`
2. Build the pooler connection string (IPv4 transaction pooler, 6543, sslmode=require):
   `postgresql://backup_readonly:<pw>@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require`
3. Store it once in SSM SecureString:
   `aws ssm put-parameter --name /stocktextalerts/backup/connection-string --type SecureString --value '<conn>'`
4. Deploy infra (adds the Lambda, schedule, alarms, lifecycle rule): `npm run deploy:aws`.

## Restore (rehearse quarterly)

1. Download an object:
   `aws s3 cp s3://stocktextalerts-prod-backups-<acct>/user-settings/<ts>.json.gz /tmp/b.json.gz`
2. Recreate schema in a scratch DB: `npm run db:reset`
3. Restore: `npm run backup:restore -- /tmp/b.json.gz "$DATABASE_URL"`
4. Verify printed row counts match the manifest and spot-check one user's settings.

The restore asserts the manifest `schema_version` matches the target; a mismatch aborts.

> Note: restore `TRUNCATE ... CASCADE`s the 4 tables before loading. The cascade
> from `users` clears dependent non-backed-up tables (e.g. `notification_log`) too —
> expected for a disaster restore into a scratch/fresh DB, where those tables are
> empty or regenerable.

## Rehearsal log

- **2026-06-13** — First end-to-end rehearsal (local). Dumped seeded DB (1 user,
  7 user_assets), deleted all `user_assets`, restored from the gzipped object:
  all 7 recovered, user intact, 0 orphaned FK rows, schema-version assertion
  exercised. Pipeline verified: COPY-in-transaction → gzip envelope → restore.
