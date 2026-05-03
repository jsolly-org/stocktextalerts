## Commands

```bash
npm run dev                # Dev server at http://localhost:4321
npm run build              # Production build
npm test                   # Vitest (requires local Supabase running)
npm run test:e2e           # Playwright E2E tests
npm run test:smoke         # Quick smoke tests
npm run check:ts           # TypeScript check
npm run check:biome        # Biome format + lint check
npm run db:start           # Start local Supabase (Docker/Podman)
npm run db:reset           # Reset DB: regenerate seed, apply migrations, regen types
npm run db:bootstrap       # Canonical first-run / "reset everything": db:start + db:reset + db:doctor
npm run db:doctor          # Preflight: auth reachable + seed user login probe (~300ms)
npm run db:gen-types       # Regenerate src/lib/db/generated/database.types.ts
supabase migration new <name>  # Create new migration (never rename timestamps)
```

**Single test file:** `npm test -- tests/lib/some-file.test.ts`
**Live provider tests:** `npm test -- --live=massive,finnhub tests/lib/live-provider-apis.test.ts`
Run vitest via `npm test` so the npm script loads `.env.local` via `--env-file-if-exists`.

## Architecture

**StockTextAlerts** — securities notification platform sending scheduled SMS/email updates for tracked US stocks and ETFs.

**Stack:** Astro 5 (SSR) on Vercel, Vue 3, Tailwind CSS 4, Supabase (PostgreSQL + Auth), Twilio (SMS), AWS SES (email), Massive (prices + asset reference), Finnhub (earnings calendar + analyst/insider extras), xAI/Grok (optional AI summaries).

### Key Directories

- `src/pages/api/` — API endpoints (auth, assets, schedule, notifications)
- `src/lib/` — Server logic: `db/`, `auth/`, `providers/`, `market-notifications/`, `daily-digest/`, `asset-events/`, `messaging/`, `schedule/`, `time/`, `logging/`
- `src/components/dashboard/` — Vue dashboard panels with composables
- `supabase/migrations/` — SQL migrations (source of truth; CI pushes to production)
- `tests/helpers/` — `test-user.ts`, `test-env.ts`, `asset-data.ts`

## Project-Specific Style

- **Biome** for all formatting/linting. `noConsole` is an error — use `src/lib/logging/` instead.
- **Astro files excluded from Biome** due to `---` delimiter formatter bug.
- **Tailwind utilities** over custom CSS. Semantic tokens via `@theme` in `src/global.css`.
- **Icons (Astro):** `Icon` from `astro-icon/components`, loads from `src/icons/*.svg`.
- **Icons (Vue):** Import SVGs via `vite-svg-loader` with `?component` suffix. No `astro-icon` in Vue.
- **No inline `<svg>` markup** — store all SVGs in `src/icons/`.
- **DB is the integrity layer**: Enforce via constraints; front-end validation is UX-only.

## Logging

- Use `src/lib/logging/` (`createLogger`, `rootLogger`) — structured JSON with `timestamp`, `level`, `message`, `context`.
- Always pass a named context object (no `{}`/`undefined`).
- **Env vars**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.
- **Lambdas also use the same logger** — `src/handlers/*.ts` import `createLogger` from `src/lib/logging`. Each Lambda log group has an `AWS::Logs::MetricFilter` on `{ $.level = "error" }` feeding the shared `stocktextalerts-crons/ErrorLogCount` metric and `ErrorLogAlarm`, alongside per-function `AWS/Lambda Errors` alarms. Cross-repo pattern: `~/.agents/rules/aws.md` → "Logging & alert-hub". Leave `LogFormat` unset on Node Lambdas — the app logger handles structure via `console.*`. Note: this repo's logger is bespoke (Vue browser-bundle compatibility via a `process` guard) — it is not a sync consumer of the canonical `~/code/family-memory/src/shared/logging.ts`.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Do not mock Supabase**: Use real client with seeded data via helpers in `tests/helpers/`.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- `formatPriceAlertSms` is **async** (shortens Grok link URLs via the `short_urls` table). Mock supabase for it must include a `.from().select().eq().gt().limit().single()` chain for the shortener dedup lookup. All other SMS formatters are sync.
- **Live API tests**: `npm run test:live:email`, `test:live:data`, `test:live:xai`, `test:live:all`. Always reproduce live test failures locally before fixing.

See `docs/testing.md` for the production-credential gating model and Mailpit dev/test routing.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. CI runs `supabase db push`.
- **Apply migrations to production only via CI's `supabase db push`.** Local-only paths: `supabase migration new <name>` then commit. (No MCP against prod, no `db push` locally, no dashboard DDL.)
- After creating/modifying a migration: `npm run db:gen-types`.
- **Regenerate `src/lib/db/generated/database.types.ts` via `npm run db:gen-types`** — it's overwritten on every run.

See `docs/local-supabase.md` for `db:bootstrap`, seed hardening, and Podman setup.

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

**SAM deploy required** when committing changes to `aws/template.yaml`, `aws/deploy.sh`, `src/handlers/`, or `src/lib/`. After the commit: `cd aws && npm run deploy` (or `npm run deploy:aws` from repo root).

## External APIs

See `docs/external-apis.md` for Massive (prices/reference) and Finnhub (earnings calendar + extras).

## CI: Reproduce CI locally with Act

See `docs/ci-with-act.md` for the 7-item pre-push checklist and act limitations (Podman socket, VM memory, deploy workflow rejection).

## AWS IAM

- `stocktextalerts-ses` — SES send-only, keys used in Vercel + .env.local for email sending
- `GitHubActionsDeploymentRole` — OIDC role for GitHub Actions CI (S3, CloudFront, ECR, Lambda, CloudFormation)
- `stocktextalerts-crons-*` — SAM-managed Lambda execution roles (auto-created)

## Production Supabase

- Credentials in `.env.local`: `SUPABASE_URL_PROD`, `DATABASE_URL_PROD`, `SUPABASE_SECRET_KEY_PROD`
- Project ref: `japesagairjvvuebzpvr`
- **psql**: `psql "$DATABASE_URL_PROD"` (pooler on port 6543)
- Access token in `.env.local` as `SUPABASE_ACCESS_TOKEN`

## Vercel CLI

Authenticated via `npx vercel` to `jsollys-projects` scope. Useful commands: `npx vercel ls`, `npx vercel inspect <url> --logs`, `npx vercel env ls`.

## Cloudflare CLI

`wrangler` is installed globally. Auth uses Global API Key (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` in `~/.zshrc`). Account: John Solly (`cloudflare@jsolly.com`), Account ID: `fe860aed6545e6e55e2808d66decf186`.

## Dev Environment

- **Prod dev-login account**: `test@jsolly.com` with `DEFAULT_PASSWORD` env var. This is the only place a real inbox is allowed to appear by name, and it exists as a row in production Supabase for interactive login during local dev against prod. It is **not** used by the test harness — `tests/helpers/constants.ts:PRESERVED_TEST_EMAIL` is `preserved-test@example.com`, deliberately non-routable.
- **Mailpit for dev email**: `.env.local` sets `EMAIL_SMTP_HOST=localhost` and `EMAIL_SMTP_PORT=1025` so any email the dev server would otherwise send through SES lands in Mailpit at http://localhost:54324 instead. Requires local Supabase running (`npm run db:start`). `tests/run-vitest.ts` strips both env vars under plain `npm test` so unit tests stay on the in-process mock sender, and re-exports them when `--live=email` is passed.

## Deploy gotchas

- **Merge to main before SAM deploy that changes env vars.** See `docs/deploy-gotchas.md`.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
