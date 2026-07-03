---
name: local-tests
description: >-
  StockTextAlerts-only: run DB-backed tests locally (Vitest, Playwright E2E) via
  npm run test:local / test:e2e:local. Not for other repos — fleet agent conventions
  live in ~/code/dotagents. Use only when the user explicitly invokes this skill or
  asks to run tests locally in stocktextalerts.
---

# Local Tests (StockTextAlerts only)

**Scope:** This skill and the `ALLOW_LOCAL_DB_TESTS` / `test:local` preflight chain are **specific to the stocktextalerts repository** (shared local Supabase, Podman container engine, CI-as-canonical test runner). Do not apply it in other `~/code` repos — those follow `~/code/dotagents` for agent workflow and each repo's own `AGENTS.md` for test commands.

Invoking this skill is explicit opt-in to run DB-backed tests on the developer's machine. GitHub CI remains the canonical runner — do not treat local results as a merge gate.

## When to run

Run locally only when the user invoked this skill or clearly asked to debug **stocktextalerts** tests on their machine. In another repo, read that repo's `AGENTS.md` and dotagents — do not reuse `test:local` here. Otherwise prefer pointing them at the PR's `CI / ci` check.

## Preflight (automatic)

`pretest` / `pretest:e2e` run `scripts/db/preflight-for-tests.ts` after the opt-in guard:

1. **Container engine** — validates `DOCKER_HOST` (ignores stale shell exports), starts a stopped Podman machine if needed, derives the live socket.
2. **Stack health** — `db:doctor`; on failure runs `db:start` once and retries doctor.
3. **Still unhealthy** — prints `npm run db:bootstrap` repair hints and exits.

Use the `test:local` / `test:e2e:local` wrappers (they set `ALLOW_LOCAL_DB_TESTS=1` and trigger the preflight chain). Manual repair is only needed when Podman VM storage is corrupted (overlay readlink errors) — see hints from `db:start`.

For E2E on port 4322, clear a stale Astro dev lock if needed: `npm run dev:stop`

All worktrees share one Supabase stack (`project_id stocktextalerts`) and serialize via `<git-common-dir>/test.lock`.

## Manual recovery (when preflight can't self-heal)

- **Engine API wedged** — `podman machine list` says running but `podman ps` hangs (machine-up ≠ engine-healthy, e.g. after a killed `db:start`): `podman machine stop && podman machine start` (~60s). `timeout`/`gtimeout` are not installed on this Mac — kill hung clients with `pkill -9 -f 'podman ps'`.
- **Stale-volume password mismatch** — auth/storage crashloop with `FATAL 28P01 password authentication failed for "supabase_storage_admin"` (also: a template1 collation-version mismatch wedging `supabase start`). `supabase stop --no-backup` cannot prune volumes on Podman (it issues a volume filter Podman rejects); remove them natively, then re-seed:

  ```bash
  export PATH="/opt/podman/bin:$PATH"
  podman ps -a --format '{{.Names}}' | grep stocktextalerts | xargs -r podman rm -f
  podman volume rm -f supabase_db_stocktextalerts supabase_storage_stocktextalerts
  npm run db:bootstrap
  ```

  Local data is throwaway — bootstrap re-seeds (~10.6k assets + seed user).
- **GoTrue email rate-limiter exhausted** — running the E2E suite repeatedly within an hour times out the recovery-email tests: `podman restart supabase_auth_stocktextalerts`.

## Commands

Preferred wrappers (opt-in + auto preflight):

```bash
# Full Vitest suite
npm run test:local

# Single file (preferred for debugging)
npm run test:local -- tests/lib/some-file.test.ts

# Playwright E2E (dev server on 4322)
npm run test:e2e:local

# Production-build E2E (preview on 4323 — pre-release / config changes)
ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e:preview

# Both suites
ALLOW_LOCAL_DB_TESTS=1 npm run test:all
```

Equivalent explicit opt-in:

```bash
ALLOW_LOCAL_DB_TESTS=1 npm test
ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e
```

Do **not** use bare `npm test` or `npx vitest` without the opt-in — `tests/guard-local-db-tests.ts` blocks them locally.

Playwright browsers aren't pre-installed in a fresh checkout/worktree: run `npx playwright install chromium` once before E2E.

## Test lock

- Wrappers acquire a cross-worktree lock and retry up to 3× (2 min apart) on contention.
- Let the retry loop finish — do not force-clear `test.lock` or spawn parallel test runs.
- If all retries fail, report the contention banner; another worktree may be running tests.
- Force-clear only when the user confirms the holder PID is dead:
  `rm $(git rev-parse --git-common-dir)/test.lock`

## Agent behavior

1. Run the requested command(s) and report pass/fail with relevant output.
2. On failure, fix only if the user asked for fixes — otherwise diagnose and stop.
3. Do not run local DB tests outside this skill unless the user explicitly opts in in the same conversation **in stocktextalerts**.
4. Static checks (`npm run check:biome`, `npm run check:ts`, `npm run build`) need no opt-in and remain fine anytime.
5. Prefer `npm run test:local` / `npm run test:e2e:local` so preflight repairs Podman/Supabase before the suite runs.
6. In other repos, follow `~/code/dotagents` — do not invoke this skill or copy these wrappers.

## Reference

- `tests/README.md` — ports, lock, Vitest guardrails
- `tests/guard-local-db-tests.ts` — opt-in guard implementation
- `scripts/db/preflight-for-tests.ts` — test preflight (Podman + doctor + auto db:start)
- `docs/github-ci.md` — what runs in CI vs local-only
- `~/code/dotagents` — fleet agent conventions (not repo-specific test bootstrap)
