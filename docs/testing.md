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
