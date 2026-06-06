# Testing Philosophy: production credentials are unreachable from tests

The harness hard-gates real-delivery paths so no test can reach prod SES or prod Twilio.

## Gates

- **Real AWS SES and real Twilio credentials are reachable only from a production build (Lambda / Vercel SSR).**
- **Three sender factories** gate via `isProduction()` from `src/lib/runtime/mode.ts` (reads `process.env.NODE_ENV`):
  - `createEmailSender` — `src/lib/messaging/email/utils.ts`
  - `createSmsSender` — `src/lib/messaging/sms/twilio-utils.ts`
  - `sendVerification` / `checkVerification` (Twilio Verify) — `src/lib/auth/sms-verification.ts`
- **App SMS sender remains production-gated.** `createSmsSender` still mocks outside production mode; live Twilio API tests run in a dedicated test file and do not route through app delivery flows.

## Mailpit (local + live email tests)

- **Live email tests** route through local **Mailpit** (Supabase's bundled Inbucket container) via SMTP on `localhost:1025`. `tests/run-vitest.ts` auto-sets `EMAIL_SMTP_HOST=localhost` when `--live=email` is passed, which makes `createEmailSender` pick the `nodemailer` branch instead of constructing a real SES client. Inspect delivered messages at <http://localhost:54324>.
- **`astro dev`** routes email through Mailpit automatically when `EMAIL_SMTP_HOST=localhost` is set in `.env.local` (the committed default). Real SES env vars in dev would defeat the gate.
- **Assertions**: use `tests/helpers/mailpit.ts` (`waitForMailpitMessage`, `waitForMailpitMessageTo`, `clearMailpit`) to inspect Mailpit content. For prod-safety unit assertions on the gates themselves, see `tests/lib/messaging/sender-gates.test.ts`.

## Twilio in tests

- **Live Twilio tests use Twilio test credentials only** (`test:live:twilio` / `--live=twilio`). They call Twilio's API with magic numbers (`+15005550006`, `+15005550009`) and do not deliver real SMS or incur charges.
- **Twilio Verify** always mocks in non-prod. The mock accepts `000000` as the only approved OTP, so local signup OTP flows can exercise both success and failure paths without hitting Twilio.

## Test recipients

**Always `@example.com`.** `tests/helpers/test-user.ts:createTestEmail` generates `<prefix>-<runId>-<uuid>@example.com`.

## Test categories

| Category | Location | What it proves |
| --- | --- | --- |
| **Product scenario (browser)** | `tests/e2e/*.e2e.spec.ts` | Real user journeys: sign-in, dashboard, profile, approval, inbound SMS. Each file owns its users via `tests/helpers/e2e/fixtures.ts`. |
| **HTTP integration** | `tests/api-http/*.test.ts` | Form posts against a running Astro dev server (`tests/helpers/http/`). Reuses port 4322 when E2E is up; otherwise starts a dedicated server on 4325. |
| **Direct handler / API** | `tests/api/**/*.test.ts` | Precise handler behavior, security edges, and DB seeding that HTTP tests do not need to repeat. |
| **Library integration** | `tests/lib/**` (e.g. `schedule/run.test.ts`, `flat-alerts/process.test.ts`) | Scheduled jobs and notification pipelines with real Supabase rows; provider HTTP stubbed. |
| **Pure unit** | `tests/lib/**` formatters, parsers, time math | No DB; fast logic checks only. |
| **Live provider (opt-in)** | `npm run test:live:*` | Real Massive, Finnhub, xAI, Mailpit SMTP, or Twilio test credentials — never run in default `npm test`. |
| **Infra guardrails** | `tests/scripts/`, hook/guard tests | Scripts, agent guards, sender gates — not product scenarios. |

### E2E helpers

Shared Playwright helpers live under `tests/helpers/e2e/` (`auth.ts`, `mail.ts`, `dashboard.ts`, `fixtures.ts`). Prefer browser sign-in over `page.request.post("/api/auth/signin")` in user-flow specs. Admin cookie injection is limited to setup via `addAuthCookies()`.

### Vitest parallelism (not enabled)

`vitest.config.ts` sets `fileParallelism: false` because tests share one local Supabase database. `tests/setup.ts` runs global cleanup after each file; `registerTestUserForCleanup` and `createTestEmail` scope data by `TEST_RUN_ID` (`tests/helpers/constants.ts`). Before enabling parallelism, trial `fileParallelism: true` in a worktree and watch for:

- Tests that mutate preserved seed users (`PRESERVED_USER_ID`, `PRESERVED_TEST_EMAIL`)
- Tests assuming no concurrent users with the same email prefix
- Global Mailpit clears racing with parallel email assertions

Per-repo test locking (`tests/run-vitest.ts` / `tests/run-playwright.ts`) prevents concurrent `npm test` and `npm run test:e2e` across worktrees; parallelism would be within a single Vitest invocation only.
