# 2026-05-10: Migration squash + prod history rewrite

## What happened

Squashed 63 historical migrations in `supabase/migrations/` into a single
baseline file (`20260509161208_migrate_market_times_to_et.sql`) and rewrote
the prod migration history table to match. This was a one-way operation —
prod's `supabase_migrations.schema_migrations` table no longer contains the
62 pre-squash version rows.

## Why

- `squawk` migration linter was being added in the same session. Running it
  against the existing 63-file corpus surfaced 81 violations on already-
  shipped migrations that could not be fixed retroactively.
- The user opted to consolidate to a clean baseline rather than carry
  per-statement ignore comments forward.
- `db:reset` runtime drops from "apply 63 migrations" to "apply 1
  migration"; meaningful local-dev win.

## How

1. `supabase migration list` showed local + remote in sync (no drift).
2. `supabase db diff --linked --schema public` confirmed schema match.
3. Saved prod migration history as a backup (rough text of `migration list`
   output).
4. `supabase migration squash --local` — generated the baseline file (pg_dump
   of current schema), kept the timestamp of the latest existing migration
   (`20260509161208`) so prod sees no new pending migration.
5. The squash output is schema-only. Manually appended INSERT statements for
   `timezones`, `app_metadata`, and `market_events` (extracted from prod via
   `pg_dump --data-only --column-inserts`); without these, `db:reset` fails
   the FK from `users.timezone` since the timezones table is empty.
6. `supabase migration repair --status reverted <62 versions>` against the
   linked prod project — bookkeeping-only edit; no DDL/DML ran on prod's
   actual schema. After repair, `supabase migration list` shows just the
   baseline row in both columns.
7. Verified locally: `db:reset` rebuilds from baseline cleanly, seed users
   present, full test suite green.

## The 62 reverted versions

Recorded for reproducibility. Versions are `<14-digit-timestamp>` matching
the original filenames. If you need to inspect the original migration
content, check git history before commit `4bb137a3`.

```text
20250101000000  20260209141004  20260209223746  20260210104707
20260211134253  20260211165536  20260211173315  20260211200000
20260211205930  20260211210000  20260212000000  20260212205148
20260213000000  20260214022156  20260214030000  20260214032133
20260214040000  20260214050000  20260214060000  20260214123902
20260214140000  20260215144103  20260215145309  20260215151647
20260215154203  20260215155328  20260215160019  20260215170000
20260215170001  20260215180000  20260215200000  20260215210000
20260217120000  20260218100000  20260218120000  20260219114306
20260219143843  20260219144318  20260219154752  20260224120000
20260225200000  20260301050000  20260302000000  20260302120000
20260302120001  20260302130000  20260303120000  20260303130000
20260304120000  20260305120000  20260305130000  20260305140000
20260306120000  20260306130000  20260306140000  20260306150000
20260306160000  20260408180000  20260410120000  20260410130000
20260414120000  20260418130000
```

## To reproduce a future squash

```bash
supabase --version  # ensure ≥ 2.98.0 for squash + repair fixes
supabase migration list                                # check sync
supabase db diff --linked --schema public              # check schema drift
supabase migration squash --local                      # generates baseline

# Append data INSERTs from prod for any tables required as FK targets
# (timezones, app_metadata, market_events for this project):
pg_dump --data-only --no-owner --no-acl \
  --column-inserts \
  --table=public.timezones \
  --table=public.app_metadata \
  --table=public.market_events \
  "$DATABASE_URL_PROD" \
| grep "^INSERT INTO" >> supabase/migrations/<latest-baseline>.sql

npm run db:reset      # local sanity
npm run db:doctor     # confirm seed completes

# Repair prod history. Versions = the 14-digit timestamps from migration list
# above, EXCEPT the latest one (which becomes the new baseline).
supabase migration repair --status reverted <space-separated versions>
supabase migration list  # verify only the baseline row remains
```

## Aftermath

- A new follow-up migration `20260510165122_secure_daily_asset_stats.sql`
  enabled RLS on `daily_asset_stats` (the only public-schema table without
  it; previously protected only by service-role-only writes plus the
  Lambda's own logic). Caught by retroactive review of the squash.
- The `market_events_id_seq` setval was added to the squashed file so fresh
  `db:reset` envs don't collide on auto-id IPO upserts. Prod is unaffected
  (the sequence is naturally advanced through normal operation).
- The squashed file is excluded from `squawk` lint via
  `scripts/db/check-sql.sh` because pg_dump's IDENTITY column / SEQUENCE
  NAME syntax exceeds squawk's parser.

## Rule note

`AGENTS.md` says "Apply migrations to production only via CI's
`supabase db push`." `supabase migration repair` is a metadata edit and
not a `db push`, but it's adjacent enough that a future contributor should
not autopilot it without invoking this runbook. Treat squashes as a
deliberate, scheduled action; not a routine one.
