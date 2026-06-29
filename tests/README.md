# Testing

StockTextAlerts uses Vitest for unit/integration tests and Playwright for browser E2E. Both suites share one local Supabase stack and serialize access through a cross-worktree lock.

**Repo-specific:** Local opt-in guards, `test:local` preflight (Podman + `db:doctor` + auto `db:start`), and the `local-tests` Cursor skill apply only to this repository. Other repos under `~/code` follow `~/code/dotagents` for agent workflow; they use their own test and bootstrap scripts.

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
| **4325** | Dev (Vitest HTTP) | `tests/api-http/*` via `tests/helpers/http/server.ts` |

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

`vitest.config.ts` also sets `fileParallelism: false` and `sequence.concurrent: false` because tests share DB state.

## Baseline env stubs

`tests/helpers/env-stubs.ts` centralizes provider/messaging stub env vars (Massive, Finnhub, XAI, Telegram, Twilio, unsubscribe secrets). `tests/setup.ts` applies them at startup and restores them in `afterEach` so specs that call `vi.unstubAllEnvs()` cannot poison later files.

For scoped env overrides inside a file, prefer `resetTestEnvStubs()` (`unstubAllEnvs` + restore baseline) in `afterEach`/`afterAll`.

## Production credentials

Provider keys (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) live in the Lambda runtime and are **always stubbed locally**. `MASSIVE_API_KEY` is also on Vercel (logo endpoint); `TELEGRAM_BOT_TOKEN` is on Vercel (webhook). There are no local live-provider round-trips.

Post-deploy live verification uses the scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/live-provider-check.ts`).

## Email routing (Mailpit)

Test email never hits real SES.

- **Unit tests:** in-process mock sender (`tests/setup.ts` mocks `createEmailSender` unless `EMAIL_SMTP_HOST` is set — Vitest strips it).
- **E2E / `MODE=test` dev:** `EMAIL_SMTP_HOST=localhost` routes to Mailpit (Supabase bundled Inbucket). Mailpit HTTP API: Supabase API port + 3 (default `54324`). Helpers: `tests/helpers/mailpit.ts`.

## Playwright policy

- **Global retries:** `0` in `playwright.shared.ts`. Serial suites that mutate DB/page state must not auto-retry.
- **Route walker exception:** `tests/e2e/routes.e2e.spec.ts` sets `retries: 1` locally (stateless navigation).
- **`reuseExistingServer`:** enabled locally, disabled in CI (`playwright.config.ts`).
- **Web server env:** vendor modules aliased to no-op stubs when `MODE=test` (see `astro.config.ts`); deterministic `TWILIO_AUTH_TOKEN` stub for inbound SMS E2E, Mailpit SMTP settings inherited from `.env.local`.
- **Origins:** derive from Playwright `baseURL` / `page` origin instead of hardcoding `:4322` where practical.
- **Waits:** prefer route gates, response barriers, and `expect.poll` over fixed `waitForTimeout`.

## Clock-sensitive tests

When asserting against Postgres `NOW()` RPCs, use fixed far-past / far-future timestamps and compare by epoch (Postgres may normalize timestamptz string formatting on read). Avoid `new Date()` relative fixtures that can straddle retention or cooldown boundaries.

## Schema version

After migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`. `tests/setup.ts` fails fast on mismatch.
