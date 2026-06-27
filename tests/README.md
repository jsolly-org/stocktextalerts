# Testing

StockTextAlerts uses Vitest for unit/integration tests and Playwright for browser E2E. Both suites share one local Supabase stack and serialize access through a cross-worktree lock.

## Supported entrypoints

| Command | Wrapper | Notes |
| --- | --- | --- |
| `npm test` | `tests/run-vitest.ts` | Preferred. Loads `.env.local`, runs `db:doctor` preflight, acquires test lock. |
| `npm run test:e2e` | `tests/run-playwright.ts` | Starts Astro on port **4322** (`MODE=test`). Acquires test lock. |
| `npx vitest` / IDE runner | `vitest.config.ts` | Also normalized — see guardrails below. |

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
- Deletes `SKIP_VENDOR_HTTP_IN_TEST` (E2E/build flag; unit tests mock `fetch` instead)

`vitest.config.ts` also sets `fileParallelism: false` and `sequence.concurrent: false` because tests share DB state.

## Baseline env stubs

`tests/helpers/env-stubs.ts` centralizes provider/messaging stub env vars (Massive, Finnhub, XAI, Telegram, Twilio, unsubscribe secrets). `tests/setup.ts` applies them at startup and restores them in `afterEach` so specs that call `vi.unstubAllEnvs()` cannot poison later files.

For scoped env overrides inside a file, call `vi.unstubAllEnvs()` then `restoreBaselineTestEnvStubs()` in `afterEach`/`afterAll`.

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
- **Web server env:** `SKIP_VENDOR_HTTP_IN_TEST=1`, deterministic `TWILIO_AUTH_TOKEN` stub for inbound SMS E2E, Mailpit SMTP settings inherited from `.env.local`.
- **Origins:** derive from Playwright `baseURL` / `page` origin instead of hardcoding `:4322` where practical.
- **Waits:** prefer route gates, response barriers, and `expect.poll` over fixed `waitForTimeout`.

## Clock-sensitive tests

When asserting against Postgres `NOW()` RPCs, use fixed far-past / far-future timestamps and compare by epoch (Postgres may normalize timestamptz string formatting on read). Avoid `new Date()` relative fixtures that can straddle retention or cooldown boundaries.

## Schema version

After migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`. `tests/setup.ts` fails fast on mismatch.
