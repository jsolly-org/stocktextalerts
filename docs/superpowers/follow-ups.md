# Follow-ups

Items deferred from completed work. Each entry: short context + when it surfaced. Pick up when the relevant adjacent work is fresh in mind.

## Investigate per-worktree Supabase isolation (beyond the test lock)

**Surfaced:** 2026-05-09, while implementing the half-day override (FU#3) inside a worktree. Hit a wall: the local Supabase DB is shared across main and all worktrees, and a mid-flight migration on main broke the schema_version check from inside the worktree.

**Status:** the cross-worktree test concurrency lock (`tests/lock.ts`, shipped 2026-05-09) addresses the *concurrent test run* class of collisions by serializing test runs across worktrees. It does NOT isolate DB state — a `db:reset` from any worktree still affects the shared DB, and an in-flight migration on main still bleeds into worktrees.

**Why pursue further:** with weekly+ worktree usage AND ongoing migration work on main, the lock covers serial-test-run collisions but not parallel-dev state divergence. Two options remain if the lock proves insufficient:

1. **Per-worktree DATABASE within shared Supabase stack** — each worktree's `.env.local` points to a unique DB (e.g. `postgres_<branch>`). One Postgres process, many DBs. Apply migrations per worktree. Requires: (a) a `scripts/db/init-worktree-db.sh` that does `psql -c "CREATE DATABASE \"stocktextalerts_$(git branch --show-current)\""` then runs migrations + seed; (b) per-worktree `.env.local` overriding `SUPABASE_URL`/`DATABASE_URL`; (c) cleanup hook on `git worktree remove`. Open question: can the local stack's GoTrue / PostgREST containers be configured to point at multiple DBs simultaneously, or do we need per-worktree containers?
2. **Per-worktree FULL stack** — separate `supabase/config.toml` with unique `project_id` + port range per worktree. Perfect isolation, ~1-2 GB RAM + port shuffle per worktree.

Pick when the lock proves insufficient (e.g., next time a worktree's test run is materially blocked by main's DB state).
