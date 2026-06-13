# User-Settings Backup — Design

**Status:** Approved (grilled 2026-06-13)
**Slug:** `user-settings-backup`

## Goal

Maintain independent, offsite, restorable copies of the *user-authored* data in the
production Supabase database, in storage we control, so that a Supabase account
compromise, billing lapse, vendor failure, or an accidental destructive write can be
recovered from — without paying for Supabase Pro/PITR.

## Problem

- We run on Supabase **Free**: no automated backups, no PITR.
- The only credential that can reach production Postgres (`DATABASE_URL_PROD`, the
  `postgres` super-role) lives solely in a laptop's gitignored `.env.local`. The
  architecture deliberately keeps prod credentials out of CI/cloud.
- If a user's settings are lost (fat-fingered `DELETE`, bad migration, vendor outage),
  there is currently **nothing** to restore from.

## Scope

### In scope — back these up (user-authored, irreplaceable)

- `public.users`
- `public.user_assets`
- `public.price_targets`
- `public.scheduled_notifications`

### Explicitly out of scope

- **`auth` schema** (Supabase-managed identities/passwords). Treated as disposable —
  on a total-loss restore, users re-register. We own app data, Supabase owns auth.
- **Regenerable data:** all `asset_*` tables, `assets`, `timezones`, `market_events`,
  `daily_asset_stats` (provider/reference/computed — re-fetchable).
- **Operational/transient:** `notification_log`, `rate_limit_log`, `short_urls`,
  `staged_notifications`, `price_move_alert_state`,
  `market_asset_price_alert_cooldowns`, `app_metadata`.

## Decisions (and the reasoning that survived grilling)

| Decision | Choice | Why |
| --- | --- | --- |
| Recovery model | **Periodic logical snapshots**, RPO = interval | True PITR needs continuous WAL archiving, which Supabase Free does not expose. *Free + correct* was chosen over *PITR + paid*. |
| No event sourcing | **Rejected** | The valuable writes originate in the **web/API tier** (Vercel SSR: `auth/register`, `price-targets/save`, `notification-preferences/update`, `profile/*`), **not** the Lambdas. App-code logging would capture the wrong half, suffer dual-write drift, and is a worse reimplementation of the WAL. (A trigger-based audit table would be correct, but only justified as a *feature*, not a backup — not pursued.) |
| Host | **SAM-managed Lambda** on EventBridge, **5×/day** | ~150 invocations/month of a few-second function is well inside Lambda's free tier — **$0**, same as GitHub Actions. The "Lambda costs money" premise was false. Lambda keeps DB creds in AWS (off GitHub), inherits the existing error-alarm→SNS infra, and uses a reliable scheduler. |
| DB credential | Dedicated **`backup_readonly`** role, `SELECT` on the 4 tables only; connection string in **SSM SecureString** | Least privilege. A leak yields read-only access to 4 tables, never the `postgres` super-role. No prod cred in GitHub. |
| Connection path | **Session pooler, port 5432 (IPv4)** | Direct 5432 is IPv6-only (no VPC IPv6 egress from Lambda). Both poolers are IPv4 and pin one backend per transaction, so the snapshot holds either way — but Supabase routes pg_dump/backup-restore to the **session** pooler (or direct), not the transaction pooler (6543). Username is `backup_readonly.<ref>` (Supavisor tenant suffix). *(Revised from the transaction pooler after research — see As-built notes.)* |
| Export format | **`COPY <table> TO STDOUT`** (Postgres text), all 4 tables in **one `REPEATABLE READ` transaction** | COPY is the DB's own serialization — `jsonb`, `numeric`, `timestamptz`, nulls round-trip exactly; restore is `COPY FROM STDIN`. A single repeatable-read transaction prevents a torn snapshot (orphaned FK rows). `SELECT → JSON` was rejected: the `pg` driver coerces types, pushing lossy re-encoding onto restore. |
| Manifest | JSON sidecar: `taken_at`, `schema_version`, per-table row counts | Decouples data from schema (restore asserts `schema_version` matches the migration state); row counts double as the completeness/corruption check. |
| Packaging | 4 COPY files + manifest → **gzip → one S3 object** per run | Atomic upload, trivial lifecycle, self-contained restore unit. |
| Storage | Private S3 bucket: **Block Public Access + default-deny policy + SSE-S3** (no KMS) | SSE-S3 (free, automatic) encrypts at rest; BPA kills the accidental-public leak path. KMS's audit/key-control benefits weren't worth ~$1/mo here. Residual risk accepted: anyone with bucket *read* sees plaintext PII. |
| Retention | **Flat 30-day** S3 lifecycle expiry | Objects are kilobytes; tiering/rollups are complexity for no saving. |
| Monitoring | (a) Lambda-error alarm → existing SNS topic; (b) **staleness alarm**: newest object age > 6h → alert | `if: failure()`-style handlers can't catch "the job stopped running"; the staleness alarm can. |

## Acceptance Criteria

1. A scheduled Lambda runs 5×/day and writes one gzipped object per run to the private
   S3 backup bucket, containing COPY data for the 4 tables plus a manifest.
2. All 4 tables are exported within a single `REPEATABLE READ` transaction.
3. The Lambda authenticates as `backup_readonly` (SELECT-only on the 4 tables), with the
   connection string read from SSM SecureString at runtime — no DB cred in the template,
   env, or GitHub.
4. The bucket has Block Public Access on, a default-deny policy, SSE-S3, and a 30-day
   expiry lifecycle rule.
5. A CloudWatch alarm fires to the shared SNS topic on any Lambda error, and a second
   alarm fires when the newest backup object is older than 6 hours.
6. A documented restore path exists (`docs/`), and **at least one real restore has been
   rehearsed** into a scratch Postgres: schema from migrations → `COPY FROM STDIN` →
   manifest `schema_version` asserted → row counts and a spot-checked user verified.

## Out-of-band / human-only steps (not agent-automatable)

- **Set the `backup_readonly` password.** The role is created (no password / `NOLOGIN`-equivalent
  unusable) by a committed migration, but `ALTER ROLE backup_readonly PASSWORD '…'` carries a
  secret and runs once against production as a **human runbook step** (never in committed SQL,
  never via an agent). The resulting full connection string (pooler host, 6543, `sslmode=require`)
  is then stored once in SSM SecureString by a human.

## Alternatives Considered

- **Supabase Pro / PITR add-on** — correct PITR, but costs money; out of budget. Revisit if
  sub-day RPO ever becomes a hard requirement.
- **GitHub Actions host** — the original premise. Rejected: needs a prod DB cred as a GitHub
  secret (violates the no-creds-in-CI posture), is orphaned from the error-alarm infra, and uses
  a best-effort scheduler. Its only edge (runners ship `pg_dump`) is outweighed.
- **Client-side `age`/gpg encryption** — strongest at-rest protection, but key-loss makes every
  backup permanently unreadable; the failure mode is worse than the threat for a personal project.
- **Trigger-based `audit_log` table** — the *correct* way to log every change, but justified only
  as an audit/undo feature; the nightly-low-churn snapshot already makes its marginal RPO gain
  negligible.

## As-built notes (deviations discovered during implementation)

- **The backup role needs `BYPASSRLS` (critical).** Every backed-up table has row-level security
  enabled. A plain SELECT-granted role sees **zero rows** through RLS — silently, no error — so the
  Lambda would write empty backups while reporting success and firing no alarm. Caught only by
  rehearsing *as `backup_readonly`* (not the superuser, which the first rehearsal mistakenly used).
  Fix: the role is created `BYPASSRLS` (as Supabase's own `service_role` is), still SELECT-only on
  the 5 tables (`users`, `user_assets`, `price_targets`, `scheduled_notifications`, `app_metadata`).
  The role also needed `SELECT` on `app_metadata` (the export reads the schema version there first).
  **Deploy risk:** setting `BYPASSRLS` requires the migration's executing role (hosted `postgres`)
  to be able to confer it; if `supabase db push` rejects it, the fallback is per-table permissive
  RLS policies (`CREATE POLICY ... TO backup_readonly USING (true)`), which need only table ownership.
  (Confirmed deployable: prod `postgres` has `rolbypassrls` + `rolcreaterole`.)
- **Real-deploy fixes (found by the first live prod→local restore).** Two bugs local-only rehearsals
  structurally could not catch: (1) **explicit COPY column lists** — `COPY` without a column list
  aligns by physical position, and prod's column order differs from a fresh-from-migrations DB
  (squash baseline), so a real restore mis-mapped columns (`malformed array literal`). The manifest
  now stores a per-table column list (format `pg-copy-text-v2`) and restore COPYs by name, as
  `pg_dump` does. (2) **TLS** — the Supabase pooler's cert isn't in Node's trust store; `sslFor`
  always uses `rejectUnauthorized: false` for remote hosts and the connection string omits
  `sslmode=require` (which would force chain verification and fail).
- **Reused the existing `ProdBackupsBucket`, did not create a new bucket.** The SAM template
  already defined `stocktextalerts-prod-backups-<acct>` (Block Public Access, SSE-S3,
  `BucketOwnerEnforced`, versioning, `DeletionPolicy: Retain`) — purpose-built for DB backups but
  only ever written to by manual `aws s3 cp` after `pg_dump`. The backup Lambda writes under the
  `user-settings/` prefix and a prefix-scoped `ExpireUserSettings30Days` lifecycle rule keeps those
  objects to the 30-day window (the bucket's default is 365-day + Glacier-IR, kept for the rare
  manual dumps). So the Q8 framing "you need to create storage" was wrong — storage already existed.
- **`backup:restore` runs via `tsx`, not plain `node`.** `package.json` is `"type": "module"`, so a
  `.ts` entrypoint run by bare `node` resolves as ESM and rejects the extensionless relative imports
  (`ERR_MODULE_NOT_FOUND`). Every other `.ts` script in the repo runs through `tsx`; the restore
  script now does too. Caught by the Task-6 restore rehearsal, which is exactly why that gate exists.
- **`app_metadata` is a key/value table.** Schema version lives in `value` keyed by
  `key = 'schema_version'`, not a `schema_version` column — corrected in the migration, the export
  query, and the restore assertion.
- **Research-driven hardening** (`docs/superpowers/plans/2026-06-13-backup-hardening.md`). A
  deep-research pass (25 primary-source claims, 0 refuted) validated BYPASSRLS, rehearse-as-role,
  and pooler snapshot consistency, and drove four changes: (1) restore runs under
  `SET LOCAL session_replication_role = 'replica'` so triggers/FK checks don't rewrite or reject
  restored rows; (2) a sequence-guard test fails loud if a future `BACKUP_TABLES` member uses a
  sequence/identity PK (data-only COPY does not restore sequence high-water marks — moot today, all
  PKs are UUID/natural); (3) connection moved to the session pooler (above); (4) rehearsal now seeds
  all 4 tables (enum/numeric/array coverage). **Kept node-COPY over `pg_dump`-in-a-layer** — our
  schema has no sequences, so pg_dump's main edge is moot, and the trigger/FK concern is one
  `session_replication_role` line.
