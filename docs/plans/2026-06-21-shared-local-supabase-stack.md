# Shared local Supabase stack (collapse per-worktree stacks)

**Spec (inline):**

- **Goal:** Let many git worktrees be active at once without wedging Podman.
- **Problem:** Each worktree provisioned its own isolated local Supabase stack (~1GB, 10
  containers) via `scripts/db/worktree-supabase.ts` — project_id `stocktextalerts-wt-<slug>` +
  offset ports, written into a `skip-worktree`'d `supabase/config.toml`. With 9+ worktrees the
  7.45 GiB **swapless** Podman VM OOM-killed mid `supabase start`, wedging the Podman API. The
  port slot was `sha256(slug) % 8 + 1` — only **8 slots for 9+ worktrees**, so collisions were
  already guaranteed. A live dry-run found **39 orphaned volumes** accumulated from removed
  worktrees.
- **Acceptance:** One shared stack regardless of worktree count; `db:reset` in one worktree can't
  corrupt another's running suite; the migration is self-enforcing (a worktree that skips it fails
  loud, not silently); `check:ts`/`check:knip`/`check:biome`/`npm test` green.

## Decision

Collapse **N stacks → 1 shared stack** (default ports `54321/54322/54324/1025`, project_id
`stocktextalerts`). Isolation between worktrees' DB access is the **existing cross-worktree test
lock** (`<git-common-dir>/test.lock`, shared by every worktree because they share one `.git/`).
The user accepts serialization ("a worktree waiting on a lock is not a big deal; I rarely run
dev"), which is exactly the constraint that makes one stack correct.

Rejected alternatives (validated by a 6-lens design review): **lazy stop-on-switch** multiplies the
exact start/stop ops that wedge Podman; **one Postgres / per-worktree database** is impossible —
GoTrue/Supabase Auth binds one database per stack, `auth.users` can't be namespaced; **per-stack
service trimming** still leaves ~4.5 GiB across 9 worktrees on a swapless 7.45 GiB VM.

## Stack slimming (service exclusion)

On top of the collapse, the single shared stack disables containers this app never uses
(`config.toml`): `[studio] enabled = false` (also drops its `pg_meta` sidecar), `[realtime]
enabled = false` (zero `.channel()`/`.subscribe()` call sites), `[edge_runtime] enabled = false`
(no `supabase/functions/`). `[analytics]`/Vector was already off. Result: **6 containers** (db, auth,
rest, kong, storage, inbucket) instead of 10 — ~1.0 GiB for the stack, 6.2 GiB free in the VM. The
`realtime` Postgres *schema* still exists in the base image, so migrations/seed are unaffected;
`981/981` tests pass against the slimmed stack. Storage stays enabled (conservative — backups use
S3, not Supabase Storage, so it's a candidate for a later trim).

## The one new race + its fix

A shared stack means a `db:reset` in worktree A could truncate the DB while worktree B's suite
reads it. Fix: **`db:reset` now acquires the same `test.lock`** (`command: "reset"`) — so reset and
any vitest/playwright run serialize against each other. `db:start` is deliberately **not** locked
(it's on `predev`; blocking interactive dev on a test lock is wrong) and mutates no data.

## Changes (landed)

1. `tests/lock.ts` — widen `TestLockCommand` to include `"reset"`.
2. `scripts/db/reset.ts` — acquire `test.lock("reset")` (fail-fast with the contention banner);
   drop the now-impossible "unprovisioned linked worktree" fail-closed guard.
3. **Delete** `scripts/db/worktree-supabase.ts` + `tests/scripts/worktree-supabase.test.ts`.
4. `package.json` — `db:bootstrap` drops the `worktree-supabase` step; remove `db:worktree-setup`;
   add `db:collapse-worktree-stacks`; drop the now-orphaned `smol-toml` direct devDependency (kept
   as an `overrides` pin — still a transitive dep).
5. `scripts/db/worktree.ts` — keep `findMainWorktreeRoot` + `symlinkedNodeModulesMessage`; delete
   the per-worktree provisioning policy helpers (`worktreeSupabaseProvisioned`,
   `unsafeResetMessage`, `unprovisionedWorktreeMessage`, `isLinkedWorktree`).
6. `scripts/db/doctor.ts` — drop the unprovisioned check; add two shared-stack guards:
   - **schema-version drift** vs `EXPECTED_DB_SCHEMA_VERSION` (catches a worktree on a different
     migration set ~2s before vitest's own `setup.ts` check, and covers `predev`/standalone);
   - **stale-isolated-stack** guard: if `supabase/config.toml`'s project_id != `stocktextalerts`,
     fail with "run `npm run db:collapse-worktree-stacks`". `skip-worktree` *hides* the stale
     config from `git status`, so this is the only place the staleness surfaces — it makes the
     migration self-enforcing instead of a manual ritual.
7. `scripts/db/link-worktree-data.ts` — narrow `FILES_TO_LINK` to `scripts/data/users.json` only;
   `.env.local` is copied (not symlinked) by `.worktreeinclude`/`copy-worktree-includes.sh`, and
   the verbatim copy from main is already correct since every worktree shares the default ports.
8. Stale-comment cleanup: `.worktreeinclude`, `tests/run-vitest.ts`, `tests/helpers/mailpit.ts`,
   `playwright.config.ts`.
9. **New** `scripts/db/collapse-worktree-stacks.ts` — one-shot migration (below).

## The one-shot migration: `npm run db:collapse-worktree-stacks`

**Dry-run by default; pass `--apply` to execute.** Per existing worktree it clears `skip-worktree`
on `config.toml`, restores the committed default (skipping with a warning if there are edits
beyond project_id/ports), removes `supabase/.worktree/`, and rewrites only the three port lines of
`.env.local` **in place** (preserving personal vars). Then it force-removes every Podman container
and volume whose name contains the literal `stocktextalerts-wt-` — catching both live-worktree
stacks and orphans from removed worktrees.

**Safety (cf. `docs/incidents/2026-05-cloudformation-stack-deletion.md` — "never loop over all"):**
the Podman teardown is allowlist-only. A target *must* contain `stocktextalerts-wt-`; the main
stack's resources (`supabase_db_stocktextalerts`, no `-wt-`) can never match, and an explicit
assertion throws if any computed target lacks the marker. Destroys throwaway local data only.

## Residual risks (documented in docs/local-supabase.md)

- **Single point of failure:** the one shared stack being down/wedged blocks every worktree's
  tests. The collation-mismatch / stale-volume recovery is a deliberate, *named* removal of the
  `supabase_db_stocktextalerts` volume (never a loop) + `db:bootstrap`.
- **`EXPECTED_DB_SCHEMA_VERSION` is hand-maintained** — every migration must bump it or doctor /
  `setup.ts` fail-loud on a correctly-seeded DB (pre-existing discipline).
- **Shared Mailpit inbox / seed** — serialized by the lock; unit tests use the mock sender
  (`run-vitest.ts` strips `EMAIL_SMTP_HOST`); commit seed edits before a shared `db:reset`.

## Validation

`check:biome` ✓ · `check:knip` ✓ (no orphaned exports/deps) · `check:ts` 0 errors ·
`db:bootstrap` (start + reset-with-lock + doctor) ✓ on a fresh shared stack ·
`db:doctor` "schema current" + project_id guard ✓ · `npm test` **981/981** ✓ (incl. live
cross-worktree stale-lock takeover, and re-run green against the slimmed 6-container stack) ·
dry-run collapse correctly flagged 7 stale worktrees + 39 orphaned volumes with zero main-stack
targets.

## Deferred (researched, not auto-applied — see docs/todo.md)

A deep-research pass surfaced two further ideas that are **not** clean low-risk wins for this stack,
so they're follow-ups rather than part of this change:

- **Permanent collation-mismatch fix.** The in-place fix is `REINDEX DATABASE` then `ALTER DATABASE
  … REFRESH COLLATION VERSION` on the app DB *and* `template1` (since `supabase start` clones from
  it) — but our collation strings are ICU-style (`153.x`) while the cited fixes are glibc, and
  whether `[db] major_version` alone vs an image-digest pin prevents recurrence is unestablished.
  Needs verification before scripting; for now the named-volume-removal recovery (above) is the
  documented path.
- **Faster `db:reset`** via transactional `BEGIN/ROLLBACK` isolation (~98% faster) does **not**
  apply — this suite uses supabase-js over HTTP, not a direct `pg` client. Template-database
  cloning is possible but `CREATE DATABASE … TEMPLATE` doesn't copy GRANTs, which this repo's strict
  privilege contract depends on.
