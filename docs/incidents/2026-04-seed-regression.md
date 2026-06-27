# 2026-04-18 — "Assets seeded but users didn't"

## Symptom

Local Supabase came up after `supabase start`, but `auth.users` was empty while `public.assets` had its full seed. Login probes failed with `invalid_credentials` against known-good seed passwords.

## Root cause

`supabase start` was silently skipping half of `seed.sql` — the user-creation section ran without populating `auth.users`, then the assets section succeeded, leaving the stack in a partial state with no error message. Order of seed sections also masked the problem: assets came first, so the visible state looked partially populated rather than obviously broken.

## Resolution

`db:reset` re-runs `seed.sql` through a fresh Postgres session and is reliable. After the incident, `npm run db:bootstrap` was promoted to canonical: `db:start` → `db:reset` → `db:doctor`.

## Standing rules (now enforced in `scripts/db/generate-seed.ts`)

- **Section order**: users (auth + profile) → assets → user tracked assets → verification. Users come first so a partial seed surfaces as "login broken" (obvious) rather than "user silently missing while assets succeed."
- Each per-user block is wrapped in `BEGIN`/`COMMIT` for per-user atomicity.
- Final `DO $$ … $$` block `RAISE EXCEPTION`s if any expected `auth.users` / `public.users` row, or any user's tracked assets, didn't land — fails `supabase db reset` loudly.
- No psql meta-commands in generated SQL (`supabase db reset` streams over a raw Postgres connection, not psql).

See [docs/local-supabase.md](../local-supabase.md).
