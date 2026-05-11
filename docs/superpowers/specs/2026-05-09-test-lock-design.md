# Cross-worktree test concurrency lock

**Status:** Design

**Date:** 2026-05-09

## Summary

Stopgap to prevent two worktrees from running tests against the same local Supabase + Mailpit at the same time. A small per-repo lock file at `<git-common-dir>/test.lock` (visible to every worktree of this clone) is acquired by `npm test` and `npm run test:e2e` before they spawn their child process and released when the child exits. A second invocation while the lock is held fails fast with a message naming the holder; a stale lock left by a crashed run is taken over silently after a PID-liveness check.

This is explicitly a stopgap. The right long-term fix is per-worktree DB isolation (separate Supabase ports per worktree, or a containerized DB per worktree). That's a bigger project; this lock buys us correctness today without blocking that effort.

## Motivation

Tests share local-Supabase and Mailpit state. Concrete contention surfaces:

- `tests/helpers/mailpit.ts:clearMailpit()` runs in `beforeEach` for email tests and wipes ALL Mailpit messages — a parallel run from another worktree loses its emails mid-test.
- Seeded users / test users created via `tests/helpers/test-user.ts` share the Supabase auth schema. Concurrent suites collide on email uniqueness, on `auth.users` rows, and on assertions about row counts.
- `npm run db:reset` (run manually after a migration) regenerates seed data — mid-flight tests in another worktree break entirely.

Today there is no mechanism that prevents two worktrees from running `npm test` in parallel. A developer working in two worktrees (e.g., main feature + a quick fix) routinely loses test runs to flakes that aren't reproducible alone.

Per-worktree DB isolation would solve this properly but requires re-plumbing `supabase start` to use distinct ports and project names per worktree, plus updating every script that talks to localhost:54321 to read those values. Out of scope for this spec.

## Decisions (resolved during brainstorming)

- **Contention behavior:** fail-fast. The second invocation exits 1 with a message identifying the holder. No queue, no waiting, no timeout.
- **Scope:** both `npm test` (vitest) and `npm run test:e2e` (playwright). Each acquires/releases the same lock independently.
- **Stale-lock recovery:** PID-based. The lock file stores the holder's PID; on acquire, if the PID is dead (`process.kill(pid, 0)` throws `ESRCH`), the new run silently takes over and overwrites the file.
- **Lock location:** `<git-common-dir>/test.lock`. Path resolved via `git rev-parse --git-common-dir`, which returns the same physical directory from any worktree. No `.gitignore` change needed (the file lives inside `.git/`, which git already ignores its own contents).

## Non-goals

- **Per-worktree DB isolation.** The proper fix. Tracked separately.
- **Queueing or wait-with-timeout behavior.** Stopgap, deliberately simple.
- **Locking the `db:*` scripts** (`db:reset`, `db:start`, etc.). They're operator commands run rarely and intentionally; a developer running `db:reset` while tests are mid-flight is a different problem than two test runs colliding. Out of scope.
- **Locking the `pretest` doctor probe.** It's a 300ms read-only DB connectivity check; locking it adds nothing.
- **CI integration.** CI runners get fresh checkouts and run a single test invocation per job — no contention. The lock is harmless in CI (creates and removes the file once per run) but provides no value.
- **Cross-machine locking.** The `.git/` directory is local. If the same repo is mounted on a shared filesystem across machines (NFS, etc.), the lock semantics break. Not a supported configuration.

## Architecture overview

```text
┌─ npm test ──────────────────┐    ┌─ npm run test:e2e ──────────┐
│  tsx tests/run-vitest.ts    │    │  tsx tests/run-playwright.ts│
│  ──────────────────────     │    │  ──────────────────────     │
│  acquireTestLock("vitest")  │    │  acquireTestLock("playwright")
│  spawn vitest (inherit IO)  │    │  spawn playwright (inherit) │
│  exit with child status     │    │  exit with child status     │
│  releaseTestLock() in       │    │  releaseTestLock() in       │
│    exit/SIGINT/SIGTERM      │    │    exit/SIGINT/SIGTERM      │
└──────────────┬──────────────┘    └──────────────┬──────────────┘
               └──────────────┬───────────────────┘
                              ↓
                ┌─ tests/lock.ts ─────────────────┐
                │  acquireTestLock(command, path?)│
                │  releaseTestLock()              │
                │                                 │
                │  Lock file: <git-common-dir>/   │
                │            test.lock            │
                │  Content: { pid, worktreePath,  │
                │             command, startedAt }│
                └─────────────────────────────────┘
```

## Lock semantics

**Acquire** (atomic, no retries):

1. Resolve lock path from `git rev-parse --git-common-dir`. Resolve to an absolute path (`path.resolve(process.cwd(), result)`), since git can return either form depending on cwd. Cache after first call.
2. `fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx" })` — succeeds only if the file does not exist.
3. On `EEXIST`, read the existing payload and run a PID-liveness check via `process.kill(holder.pid, 0)`:
   - If the call succeeds (or fails with `EPERM`, meaning the PID exists but is owned by another user — treat as alive), the lock is genuinely held. **Throw `TestLockHeldError`** carrying the holder payload. The caller (the wrapper script) prints the contention message and exits 1.
   - If the call fails with `ESRCH`, the PID is dead. Log a one-line takeover notice to stderr, then overwrite the file (this time with `flag: "w"`) and proceed.
   - If reading the file fails (corrupt JSON, partial write from a crashed acquirer), treat as stale: log and overwrite.

**Why throw instead of `process.exit`:** keeps the lock module pure and unit-testable in-process. Unit tests `expect(() => acquireTestLock(...)).toThrow(TestLockHeldError)` rather than spawning child processes. The wrapper scripts (`run-vitest.ts`, `run-playwright.ts`) own the exit-code policy.

**Release** (best-effort):

1. Read the file. If the PID doesn't match `process.pid`, do nothing — another run took us over.
2. If it matches, `fs.unlinkSync(lockPath)`.
3. Errors during release are logged but never propagated. The process is exiting; failing to release shouldn't change the exit code.

**Release triggers** (registered by `acquireTestLock`):

- `process.on("exit", releaseTestLock)` — natural exit path
- `process.on("SIGINT", () => { releaseTestLock(); process.exit(130); })` — Ctrl+C
- `process.on("SIGTERM", () => { releaseTestLock(); process.exit(143); })` — kill
- `process.on("uncaughtException", err => { releaseTestLock(); throw err; })` — defensive

## Lock file format

```json
{
  "pid": 48721,
  "worktreePath": "/Users/johnsolly/code/stocktextalerts/.claude/worktrees/add-knip",
  "command": "vitest",
  "startedAt": "2026-05-09T22:14:02.118Z"
}
```

`worktreePath` is `process.cwd()` at acquire time — the worktree the test run was launched from. `command` is one of `"vitest"` or `"playwright"`.

## Error UX

**Contention** (stderr, then `process.exit(1)`):

```text
✗ Tests are already running.

  Holder:    /Users/johnsolly/code/stocktextalerts/.claude/worktrees/feature-x
  Command:   vitest
  PID:       48721
  Running:   4m 12s

Wait for that run to finish, or:
  - Kill it:           kill 48721
  - Force-clear (only if you're sure it's dead):
                       rm /Users/johnsolly/code/stocktextalerts/.git/test.lock
```

The `✗` is red to match the existing `.husky/pre-commit` `error_handler` styling. `Running` is computed from `Date.now() - Date.parse(startedAt)`.

**Stale takeover** (single line to stderr, before tests start):

```text
test-lock: stale lock from PID 48721 (worktree: feature-x, command: vitest, started 12m ago) — taking over
```

Only one line — this is informational, not a problem. If users see it routinely, they probably have a script that's killing test processes uncleanly.

## File-level changes

- **New:** `tests/lock.ts` — exports `acquireTestLock(command, lockPath?)` and `releaseTestLock()`. The optional `lockPath` parameter exists so the lock module's own unit tests can use a temp file rather than fighting the real lock the parent vitest holds.
- **New:** `tests/run-playwright.ts` — small wrapper mirroring `tests/run-vitest.ts`. Forwards all CLI args to `playwright test`, acquires lock with `command: "playwright"`, exits with the child's status.
- **Modified:** `tests/run-vitest.ts` — calls `acquireTestLock("vitest")` immediately after `process.env.NODE_ENV = "test"`.
- **Modified:** `package.json` — `test:e2e` and `test:e2e:preview` change from `playwright test ...` to `tsx tests/run-playwright.ts ...`. `test`, `test:ci`, `test:live:*` all already route through `run-vitest.ts` and pick up the lock automatically.
- **Modified:** `AGENTS.md` — adds a 3-4 line note under `## Testing (Project-Specific)` describing the lock and the `rm` recovery command. Self-documenting error message means no separate `docs/test-lock.md` is warranted.

No changes to:

- `.husky/pre-commit` — locking happens at the script level.
- `playwright.config.ts` / `vitest.config.ts` — the lock lives outside test framework hooks for reliability (a wrapper script process is harder to kill before release than a globalSetup).
- CI workflows — see Non-goals.

## Testing

`tests/lib/lock.test.ts` (new), six scenarios:

1. **Fresh acquire writes correct payload.** Acquire with a temp lock path, verify file content has correct `pid`, `worktreePath`, `command`, parseable `startedAt`.
2. **Concurrent acquire while alive PID holds → throws `TestLockHeldError` with full payload.** Pre-write a lock file naming `process.pid` (definitely alive), call `acquireTestLock`, assert it throws `TestLockHeldError` whose attached payload contains all four fields.
3. **Acquire when holder PID is dead → succeeds, overwrites.** Pre-write a lock file with a fabricated dead PID (e.g., one obtained by `spawn`-ing then `kill`-ing a child node), call `acquireTestLock`, assert the file's PID now matches `process.pid` and stderr contains the takeover line.
4. **Release after our own acquire unlinks the file.** Acquire, release, verify file does not exist.
5. **Release when file PID doesn't match ours → no-op.** Acquire, then overwrite the file with a different PID (simulating takeover by another run), call release, verify the file still exists with the other PID.
6. **SIGINT handler releases lock then exits 130.** Spawn a child Node process that acquires the lock and waits on stdin, send `SIGINT` from the parent, verify the lock file is gone and the child exited 130. (This is the one child-process test — necessary because signal handlers can't be exercised purely in-process.)

Manual smoke check (not automated — too fiddly for the value): two terminal windows in two different worktrees, `npm test` in both, verify the second fails fast with the right message in <100ms.

## Documentation update

`AGENTS.md`, under `## Testing (Project-Specific)`, append:

> **Test concurrency lock:** `npm test` and `npm run test:e2e` acquire a per-repo lock at `.git/test.lock` (cross-worktree). If another worktree is already running tests, the second invocation fails fast with a message identifying the holder. Stale locks (dead PID) are taken over silently. Force-clear with `rm <repo>/.git/test.lock` if you're sure the holder is dead.

## Open questions

None at design time. The brainstorming session resolved all four decision points (contention, scope, stale recovery, location) explicitly.

## Future work

- Per-worktree DB isolation. Replace this lock with proper isolation (separate Supabase ports + project names per worktree). At that point, this entire spec gets deleted.
- If the lock proves inadequate (e.g., users hitting contention often), revisit `wait-with-timeout` as a follow-on.
