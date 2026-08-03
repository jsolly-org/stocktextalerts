# Testing

StockTextAlerts uses Vitest for unit/integration tests and Playwright for browser E2E. Both suites share one local Supabase stack and serialize access through a cross-worktree lock.

## Layout (mirrors `src/`)

| Tests | Source |
| --- | --- |
| `tests/lib/**` | `src/lib/**` |
| `tests/pages/api/**` | `src/pages/api/**` |
| `tests/pages/http/**` | Full HTTP form posts against the Astro dev server |
| `tests/pages/*.test.ts` | Astro page routes (`src/pages/`) |
| `tests/handlers/**` | `src/handlers/**` |
| `tests/scripts/**` | `scripts/**` |
| `tests/e2e/**` | Browser flows (Playwright) |
| `tests/helpers/**`, `tests/stubs/**`, `tests/setup.ts`, `tests/lock.ts` | Shared test infrastructure (not mirrored) |

Security-focused API specs keep a `.security.test.ts` suffix alongside the handler mirror path (e.g. `tests/pages/api/auth/signin.security.test.ts`).

**Repo-specific:** Local opt-in guards, `test:local` preflight (Podman + `db:doctor` + auto `db:start`), and the canonical [local-tests skill](../.claude/skills/local-tests/SKILL.md) apply only to this repository. Cursor reaches the same skill through `.cursor/skills/local-tests`; do not maintain a second copy. Other repos under `~/code` follow `~/code/dotagents` for agent workflow and use their own test/bootstrap scripts.

When authoring tests, use the real Supabase client with seeded data and helpers in `tests/helpers/`. Register created users with `registerTestUserForCleanup`. Tests fail on unexpected `console.warn` / `console.error`; use `expectConsoleWarning()` / `expectConsoleError()` from `tests/setup.ts` for expected output.

## Local runs discouraged (CI is canonical)

**DB-backed tests (`npm test`, `npm run test:e2e`, `npm run test:e2e:preview`, direct `npx vitest` / Playwright) are blocked locally by default.** GitHub CI on PRs and `main` is the supported runner — it bootstraps Supabase on the runner and runs the full battery without touching your shared local stack.

Preferred local wrappers (opt-in + automatic preflight):

```bash
npm run test:local
npm run test:local -- tests/lib/some-file.test.ts
npm run test:e2e:local
```

Equivalent explicit opt-in:

```bash
ALLOW_LOCAL_DB_TESTS=1 npm test
ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e
ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e:preview
```

The guard is enforced in `tests/guard-local-db-tests.ts` (wrappers, `vitest.config.ts`, and `playwright.shared.ts`). CI sets `CI=true` and passes through automatically.

**Before pushing:** rely on the PR's `CI / ci` check — do not treat a local run as a merge gate. Local static checks (`npm run check:biome`, `npm run check:ts`, `npm run build`) remain available without opt-in.

## Astro 7 testing flow

| Port | Server | Command |
| --- | --- | --- |
| **4321** | Dev | `npm run dev` |
| **4322** | Dev (E2E) | `npm run test:e2e` — runs `astro dev stop` before start |
| **4323** | Production preview | `npm run test:e2e:preview` — `build:preview` + `npm run preview` |
| **4325** | Dev (Vitest HTTP) | `tests/pages/http/*` via `tests/helpers/http/server.ts` |

Astro 7’s project dev lock (`.astro/dev.json`) is cleared by:

- Playwright E2E (`astro dev stop` in `playwright.config.ts` webServer command)
- Vitest HTTP tests (`stopAstroDevLockAfterHttpTests()` in `tests/run-vitest.ts`)

Use `npm run dev:stop` manually if a stale lock blocks local dev.

### Preview E2E (production build parity)

`npm run test:e2e:preview` runs the same E2E specs against a **production build** served by `@astrojs/node` on port 4323. This catches Vite 8 / Rolldown issues (CSS chunking, asset hashing) that the dev server skips.

**CI:** regular `npm run test:e2e` runs in GitHub Actions. Preview E2E is a **pre-release / local** check — run before shipping Astro or Vite config changes. See `docs/github-ci.md`.

### AstroContainer page tests

`tests/pages/pages-render.test.ts` and `tests/pages/email-unsubscribe.test.ts` use `experimental_AstroContainer` with `@astrojs/vue/container-renderer`.

### Post-upgrade HTML audit

After Astro major upgrades, visually inspect `.astro` pages under `src/pages/` and `src/components/` for:

- Missing spaces between adjacent inline elements (Astro 7 default `compressHTML: "jsx"`)
- Invalid HTML nesting the Rust compiler no longer auto-corrects

Prefer explicit `{" "}` or markup fixes over setting `compressHTML: true` globally.

## Supported entrypoints

| Command | Wrapper | Notes |
| --- | --- | --- |
| `npm test` | `tests/run-vitest.ts` | Blocked locally unless `ALLOW_LOCAL_DB_TESTS=1` or `npm run test:local`. Loads `.env.local`, runs test preflight (`preflight-for-tests.ts`), acquires test lock. |
| `npm run test:e2e` | `tests/run-playwright.ts` | Same opt-in. Starts Astro on port **4322** (`MODE=test`). Acquires test lock. |
| `npx vitest` / IDE runner | `vitest.config.ts` | Same opt-in — see guardrails below. |

Do **not** force-clear `test.lock` while another worktree's suite is running. The wrappers retry for up to ~6 minutes (3 × 2 min) before printing a contention banner.

## Cross-worktree test lock

Lock file: `<git-common-dir>/test.lock` (shared by all worktrees).

- Held by `vitest`, `playwright`, and `db:reset`.
- Released in a `finally` block after the child process exits (not only on `process.exit` handlers).
- Stale/corrupt locks (dead PID, invalid payload) are taken over silently on the next acquire.

## Vitest environment guardrails

Direct Vitest invocation (IDE, `npx vitest`) loads `.env.local` then applies `normalizeDirectVitestProcessEnv()` from `tests/helpers/test-process-env.ts`:

- Sets `NODE_ENV=test`
- Clears `EMAIL_SMTP_HOST` (real SMTP + fake timers deadlock unit tests)

`vitest.config.ts` sets `sequence.concurrent: false`, so tests inside one file always run one at a time. Files run in parallel; see "Parallelism" below.

## Baseline env stubs

`tests/helpers/env-stubs.ts` centralizes provider/messaging stub env vars (Massive, Finnhub, XAI, Telegram, unsubscribe secrets). `tests/setup.ts` applies them at startup and restores them in `afterEach` so specs that call `vi.unstubAllEnvs()` cannot poison later files.

For scoped env overrides inside a file, prefer `resetTestEnvStubs()` (`unstubAllEnvs` + restore baseline) in `afterEach`/`afterAll`.

## Production credentials

Provider keys (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) live in the Lambda runtime and are **always stubbed locally**. `MASSIVE_API_KEY` is also on Vercel (logo endpoint); `TELEGRAM_BOT_TOKEN` is on Vercel (webhook). There are no local live-provider round-trips.

Post-deploy live verification uses the scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/maintenance/live-provider-check.ts`).

**This is enforced, not just documented.** `tests/helpers/network-guard.ts` replaces `fetch` (plus `request`/`get` on `node:http` and `node:https`, which is what pre-fetch SDKs such as the AWS SDK use) with a guard that rejects any host outside the local stack, installed in two places: every Vitest file (`tests/network-guard-setup.ts`) and the `MODE=test` Astro dev server (`blockNonLocalFetchPlugin` in `astro.config.ts`, which also covers the server the HTTP page specs use). A spec that forgets a mock, or a route that calls `fetch` directly instead of going through an aliased vendor module, now fails with a message naming the blocked URL. `*.live.test.ts` is the one exception and the guard stands down for it.

## Email routing (Mailpit)

Test email never hits real SES.

- **Unit tests:** in-process mock sender (`tests/setup.ts` mocks `createEmailSender` unless `EMAIL_SMTP_HOST` is set — Vitest strips it).
- **E2E / `MODE=test` dev:** `EMAIL_SMTP_HOST=localhost` routes to Mailpit (Supabase bundled Inbucket). Mailpit HTTP API: Supabase API port + 3 (default `54324`). Helpers: `tests/helpers/mailpit.ts`.
- **Clearing the inbox:** use `clearMailpitFor(recipient)`, never a blanket delete. Mailpit is one shared instance across every worker, so deleting all messages destroys mail another test is waiting on. Address the mailbox you are about to assert against.
- **Unique recipients:** derive addresses from `randomUUID()`, not `Date.now()` or a fixed string, so two workers cannot collide on one mailbox.

## Playwright policy

- **Workers:** `2` in `playwright.shared.ts`, sized for the 4-vCPU CI runner (which also carries Astro dev and Supabase). Specs create their own users; the shared Mailpit inbox is cleared per recipient, never globally.
- **Global retries:** `0` in `playwright.shared.ts`. Suites that mutate DB/page state must not auto-retry.
- **Route walker exception:** `tests/e2e/routes.e2e.spec.ts` sets `retries: 1` locally (stateless navigation).
- **`reuseExistingServer`:** enabled locally, disabled in CI (`playwright.config.ts`).
- **Web server env:** vendor modules aliased to no-op stubs when `MODE=test` (see `astro.config.ts`); Mailpit SMTP settings inherited from `.env.local`.
- **Vendor HTTP:** anything the server fetches from a provider must go through `src/lib/vendors/massive.ts`, `finnhub.ts`, or `src/lib/vendors/http.ts`; those three are the aliased modules. A direct `fetch` to a vendor bypasses the stub and makes a live call from CI (the logo proxy and icon probe did exactly that).
- **What the HTTP stub answers:** `tests/stubs/vendors/http.ts` serves a real 1x1 PNG for logo/branding URLs, so the dashboard logo proxy and the email logo fetcher run their success paths (content-type allowlist, `MAX_LOGO_BYTES`, base64 inlining) instead of collapsing to "vendor unavailable". The Massive **ticker-detail** probe stays 503 on purpose: a 200 makes `checkAndStoreIcon` write `icon_url` + `icon_checked_at` mid-spec and clobber fixture values. Unit specs that want a failing upstream import `tests/stubs/vendors/http-unavailable.ts` instead, which 503s everything.
- **Origins:** derive from Playwright `baseURL` / `page` origin instead of hardcoding `:4322` where practical.
- **Waits:** prefer route gates, response barriers, and `expect.poll` over fixed `waitForTimeout`.

## Parallelism

The suite runs test **files** in parallel (tests within a file stay sequential). Two structural rules make that safe, and new tests have to keep them.

**1. Run-wide setup belongs in `tests/global-setup.ts`, not `beforeAll`.** A `beforeAll` in `tests/setup.ts` executes once per *file*. Schema and admin-credential verification were paying that ~180 times for an answer that cannot change mid-run, and the run-wide user wipe was worse than wasteful: it deleted users other workers were actively asserting on. Those three now run once, before any worker starts. Per-test cleanup is unchanged: register users with `registerTestUserForCleanup` and the `afterEach` in `tests/setup.ts` removes exactly yours.

**2. A test owns only the rows it creates.** Under parallelism another worker is always inserting and deleting concurrently, so:

- Assert on *your* rows, not on table totals. `expect(assets).toHaveLength(4)` is a race; `expect(rows.map(r => r.symbol)).toContain("AAPL")` is not.
- Derive fixture identifiers from `randomUUID()` so two workers cannot pick the same symbol, email, or mailbox.
- Never delete or clear globally. Scope every teardown to the ids or addresses the test created (this is why `clearMailpitFor` replaced the blanket Mailpit delete).

Some tests cannot follow rule 2 because the whole table *is* the subject: `runUniverseReconcile` counts every asset, and `runScheduledNotifications({ supabase, logger })` processes every user due at time T. Scoping them would change what they cover, so they are listed in [`tests/serial-test-files.ts`](serial-test-files.ts) and run in a second, serial pass after the parallel one. `npm test` runs both passes and fails if either does; a filtered run (`npm test -- some.test.ts`) is a single pass.

**3. Shared processes belong to the run, not to a file.** The `tests/pages/http/**` specs share one Astro dev server on port 4325. They were serialized for a while because the server was started lazily by whichever worker got there first and then stopped by the `afterAll` in `tests/setup.ts`, which runs once per *file*: any file finishing killed the server the others were using. The lifecycle now lives at run level (a cross-worker lock in `tests/helpers/http/server.ts`, teardown in `tests/global-setup.ts`), so those files run in parallel. If you add another shared process, own it the same way.

Keep that list short. An entry is a file that no longer gets any parallelism, so prefer fixing a shared-state assumption over adding one. A test that fails only when run alongside others is telling you it reads something it does not own.

## Clock-sensitive tests

When asserting against Postgres `NOW()` RPCs, use fixed far-past / far-future timestamps and compare by epoch (Postgres may normalize timestamptz string formatting on read). Avoid `new Date()` relative fixtures that can straddle retention or cooldown boundaries.

## Schema version

After migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `src/lib/db/schema-version.ts`. `tests/setup.ts` fails fast on mismatch.
