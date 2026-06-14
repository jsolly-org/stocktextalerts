# User-Settings Backups

Backs up 4 user-authored tables (`users`, `user_assets`, `price_targets`,
`scheduled_notifications`) 5×/day to the existing private S3 bucket
`stocktextalerts-prod-backups-<acct>` under the `user-settings/` prefix.
Design: `docs/specs/2026-06-13-user-settings-backup-design.md`.

## One-time setup (human only — never via an agent)

1. Set the role password against production (human runbook; not in committed SQL):
   `ALTER ROLE backup_readonly LOGIN PASSWORD '<generated>';`
2. Build the **session pooler** connection string (IPv4-compatible, port **5432** on the pooler
   host). Supabase routes backup/restore to the session pooler or direct connection, not the
   transaction pooler (6543). Supavisor requires the project ref in the username
   (`backup_readonly.<project-ref>`). Do **not** append `sslmode=require` — the code connects with
   TLS but without CA verification (the pooler's cert isn't in Node's trust store), and a
   `sslmode=require` in the string makes node-postgres verify the chain and fail:
   `postgresql://backup_readonly.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres`
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

> Note: restore runs under `SET LOCAL session_replication_role = 'replica'`, so triggers and FK
> checks are disabled during the load and rows are restored byte-faithfully (the `users`
> approval-guard trigger and `updated_at` triggers do not fire). It then `TRUNCATE ... CASCADE`s
> the 4 tables before loading. The cascade from `users` also clears these non-backed-up dependent
> tables: `notification_log`, `rate_limit_log`, `market_asset_price_alert_cooldowns`,
> `price_move_alert_state`, `staged_notifications` — expected for a disaster restore into a
> scratch/fresh DB, where those are empty or regenerable. The script refuses non-local targets
> unless `RESTORE_ALLOW_REMOTE=1`.

## Rehearsal log

- **2026-06-13** — First end-to-end rehearsal (local), run **as the `backup_readonly`
  role** (not the superuser) so the real production privilege path was exercised.
  This surfaced two production-blocking bugs before deploy: (1) the role lacked
  `SELECT` on `app_metadata` (the export's first query), and (2) RLS on the tables
  filtered every row to zero for a plain SELECT role → the role now has `BYPASSRLS`.
  After both fixes: dumped seeded DB (1 user, 7 user_assets), deleted all
  `user_assets`, restored from the gzipped object — all 7 recovered, user intact,
  0 orphaned FK rows, schema-version + per-table row-count assertions exercised.
  **Always rehearse as `backup_readonly`, never the superuser** — the superuser
  masks both RLS filtering and missing grants.
- **2026-06-13 (hardening pass)** — Re-rehearsed as `backup_readonly` with
  representative data in all 4 tables (enum, numeric, and array columns). Confirmed
  enum (`notification_type=daily`, `channel=email`, `status=sent`) and numeric
  (`target_price=150.5000`) values round-trip byte-faithfully through COPY, restore
  runs cleanly under `session_replication_role=replica`, counts match, 0 orphans.
  Backed by a deep-research pass (see `docs/plans/2026-06-13-backup-hardening.md`).
