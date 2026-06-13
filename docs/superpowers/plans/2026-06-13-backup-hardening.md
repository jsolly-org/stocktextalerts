# Backup Hardening Plan (post-research)

> Follow-up to `docs/superpowers/plans/2026-06-13-user-settings-backup.md`.
> **Spec:** docs/superpowers/specs/2026-06-13-user-settings-backup-design.md (see its "As-built notes").

**Driver:** a deep-research pass (25 primary-source claims, 0 refuted) on COPY-based logical
backup/restore of Supabase, cross-checked against this repo's actual schema. Decision: **keep the
node-COPY pipeline and harden it** (do not rebuild around `pg_dump` — our schema has no sequences,
so pg_dump's main advantage is moot, and a version-matched Lambda binary is the maintenance burden
we deliberately avoided).

## What the research confirmed is already correct (no change)

- **BYPASSRLS** on the read role — the idiomatic way to read RLS tables at full fidelity.
- **Rehearse as the real `backup_readonly` role** — superuser/owner silently bypasses RLS.
- **Pooler snapshot consistency holds** — pgBouncer/Supavisor transaction mode pins one backend per
  `BEGIN…COMMIT`, so the multi-COPY `REPEATABLE READ` snapshot is consistent.
- **No sequence bug for us** — all 4 tables use UUID/natural-key PKs; verified zero sequence/identity
  columns. (Data-only COPY does NOT restore sequence high-water marks — it would bite a serial-PK
  table, hence the guard test below.)
- **Generated column** (`users.full_phone`) — COPY excludes it symmetrically; recomputed on restore.

## Issues to fix

### P1.1 — Restore disables triggers + FK enforcement during load

`COPY FROM` fires triggers and checks. `users` has a `prevent_user_approval_self_change` BEFORE
INSERT trigger; it bypasses for `current_user='postgres'` (how we restore today) but is a latent trap
for any non-postgres restore role or any future row-mutating trigger.

- **File:** `scripts/backup/restore.ts`
- **Change:** after `BEGIN`, run `SET LOCAL session_replication_role = 'replica';`. This disables all
  non-replica triggers and FK enforcement for the transaction (auto-resets on COMMIT/ROLLBACK because
  it's `SET LOCAL`), making restore faithful regardless of the connecting role and future triggers.
  Requires the restore role to be able to set it (postgres can).

### P1.2 — Sequence-guard test

Data-only COPY restore silently omits sequence high-water marks → PK collisions on the next INSERT.
Not a problem today (no sequences), but a future serial/identity-PK table added to `BACKUP_TABLES`
would silently break restore.

- **File:** `tests/lib/backup/no-sequence-columns.test.ts` (new)
- **Change:** query `information_schema.columns` for any `BACKUP_TABLES` column with
  `is_identity='YES'` or `column_default LIKE 'nextval(%'`; assert none. Fails loud if a sequence-
  backed table joins the set, forcing whoever adds it to implement `setval` on restore.

### P2.3 — Use the session pooler, not the transaction pooler

Supabase officially routes pg_dump/backup-restore to the **direct or session pooler**, not the
transaction pooler (6543). Snapshot consistency holds either way, but the session pooler is the
recommended, IPv4-compatible choice for a Lambda. No code change (the connection string is the
human-set SSM value) — runbook + spec doc update only.

- **Files:** `docs/backups.md`, `docs/superpowers/specs/2026-06-13-user-settings-backup-design.md`
- **Change:** connection string → session pooler host, **port 5432**, username
  `backup_readonly.<project-ref>` (Supavisor requires the tenant suffix), IPv4.

### P2.4 — Rehearsal data coverage

The first rehearsal had 0 rows in `price_targets` / `scheduled_notifications`, so enum
(`delivery_method`, `scheduled_notification_type/_status`) and numeric round-trips were never
exercised (the array column on `users` *was*, via the seed user).

- **Action:** seed representative rows in all 4 tables, run dump-as-`backup_readonly` → wipe →
  restore → verify counts + spot-check an enum and a numeric value survived byte-faithfully; then
  `db:reset` to clean state. Record in the rehearsal log.

### P2.5 — Document TRUNCATE CASCADE blast radius

`TRUNCATE users CASCADE` on restore also wipes `notification_log`, `rate_limit_log`,
`market_asset_price_alert_cooldowns`, `price_move_alert_state`, `staged_notifications` (verified).
Fine for a scratch restore (already guarded against remote via `RESTORE_ALLOW_REMOTE`), but document
the reach in the runbook.

## Verification

- New + existing backup tests pass; `check:ts/biome/knip/sql` green.
- Full rehearsal as `backup_readonly` with representative data: dump → wipe → restore → row counts
  match, enum + numeric + array values intact, 0 orphans.
- Docs lint clean.
