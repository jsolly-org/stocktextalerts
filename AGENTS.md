## Purpose

New app with no users — optimize for simplicity and correctness over backwards compatibility. Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it.

## Commands

```bash
npm run dev                # Dev server at http://localhost:4321
npm run build              # Production build
npm test                   # Vitest (requires local Supabase running)
npm run test:e2e           # Playwright E2E tests
npm run test:smoke         # Quick smoke tests
npm run check:ts           # TypeScript check
npm run check:biome        # Biome format + lint check
npm run db:start           # Start local Supabase (Docker)
npm run db:reset           # Reset DB: regenerate seed, apply migrations, regen types
npm run db:gen-types       # Regenerate src/lib/db/generated/database.types.ts
supabase migration new <name>  # Create new migration (never rename timestamps)
```

**Single test file:** `npm test -- tests/lib/some-file.test.ts`
**Live provider tests:** `npm test -- --live=massive,finnhub tests/lib/live-provider-apis.test.ts`
**Always use `npm test`**, never `npx vitest` directly — the npm script loads `.env.local` via `--env-file-if-exists`.

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
- **Trust DB values**: No null checks for NOT NULL columns or FK-guaranteed data.

## Logging

- Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) — structured JSON with `timestamp`, `level`, `message`, `context`.
- Always pass a named context object (no `{}`/`undefined`).
- **Env vars**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Do not mock Supabase**: Use real client with seeded data via helpers in `tests/helpers/`.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- Pre-existing type error in `src/pages/api/auth/sms/send-verification.ts:201` (nullable param to RPC) — not ours, ignore.
- `formatSmsMessage`, `formatDailyDigestSmsMessage`, `formatPriceAlertSms`, `formatAssetEventsSmsMessage` are all **async** (URL shortening).
- Mock supabase for SMS formatters must include a `.from().select().eq().gt().limit().single()` chain for the URL shortener dedup lookup.
- **Live API tests**: `npm run test:live:email`, `test:live:sms`, `test:live:all`. Always reproduce live test failures locally before fixing.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. CI runs `supabase db push`.
- **Never apply migrations directly to production** (no MCP against prod, no `db push` locally, no dashboard DDL).
- After creating/modifying a migration: `npm run db:gen-types`.
- Do NOT modify `src/lib/db/generated/database.types.ts` directly.

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

**SAM deploy required** when committing changes to `aws/template.yaml`, `aws/deploy.sh`, `aws/src/handlers/`, or `src/lib/`. After the commit: `cd aws && npm run deploy`. Use `--profile prod-admin` for all production AWS commands.

## External APIs

- **Massive** (formerly Polygon.io, rebranded Oct 2025) — paid $29/mo plan (unlimited requests, recommended <100 req/s). API at `api.massive.com` (legacy `api.polygon.io` still works). Always refer to as "Massive" in code/comments. Also the sole source of live snapshot quotes, prev-day bars, and the asset reference universe used to seed `scripts/data/us-assets.json`.
- **Finnhub** — free tier only. Used for the earnings calendar (`/calendar/earnings` via `fetchFinnhubEarnings` in `src/lib/providers/massive.ts`, because Massive's earnings endpoint isn't entitled on our plan) and the "extras" bundle (analyst recommendations + insider transactions via `fetchFinnhubExtras` in `src/lib/providers/finnhub.ts`). Never used for live quotes — the quote path is Massive-only, falling back to prev-day bars for snapshot misses.
- **Massive ticker counts** (as of 2026-03-06): ~5,257 CS + ~378 ADRC = ~5,635 stocks; ~5,021 ETFs.

## AWS IAM

- `jsolly-prod-admin` — admin user for local CLI (prod-admin profile)
- `stocktextalerts-ses` — SES send-only, keys used in Vercel + .env.local for email sending
- `amplify-admin` — Amplify deployments
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

## SMS Provider

Evaluating cheaper alternatives to Twilio (as of 2026-04-05). AWS SNS preferred (~$0.00645/segment, no monthly number fee) unless inbound SMS is needed. No decision made yet — exploratory.

## Dev Environment

- Login: `test@jsolly.com` with `DEFAULT_PASSWORD` env var
- **Act** for testing GitHub Actions locally: `brew install act`, `act -l` to list jobs. Deploy workflow skips under act (`github.actor != 'nektos/act'`).

## SES Migration History

Resend→SES email migration (PR #414) merged 2026-03-31. Notifications were down Mar 29–31 due to premature SAM deploy from feature branch that removed RESEND_API_KEY before merge. Lesson: always merge to main before SAM deploy that changes env vars.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
