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

**Stack:** Astro 5 (SSR) on Vercel, Vue 3, Tailwind CSS 4, Supabase (PostgreSQL + Auth), Twilio (SMS), AWS SES (email), Massive (prices), Finnhub (symbols/earnings), xAI/Grok (optional AI summaries).

### Key Directories

- `src/pages/api/` — API endpoints (auth, assets, schedule, notifications)
- `src/lib/` — Server logic: `db/`, `auth/`, `providers/`, `market-notifications/`, `daily-digest/`, `asset-events/`, `messaging/`, `schedule/`, `time/`, `logging/`
- `src/components/dashboard/` — Vue dashboard panels with composables
- `supabase/migrations/` — SQL migrations (source of truth; CI pushes to production)
- `tests/helpers/` — `test-user.ts`, `test-env.ts`, `asset-data.ts`

## Code Style

- **Biome** for all formatting/linting. `noConsole` is an error — use `src/lib/logging/` instead.
- **Astro files excluded from Biome** due to `---` delimiter formatter bug.
- **Relative paths only**: No `@`-style aliases. No barrel files / re-exports.
- **No compatibility layers**: No shims, adapters, deprecations, or re-exports for legacy behavior.
- **No browser polyfills**: Modern browser APIs assumed. Server-side polyfills fine when Node.js lacks the API.
- **No timing hacks**: No `setTimeout`/`nextTick`/`requestAnimationFrame` to mask race conditions.
- **Tailwind utilities** over custom CSS. Semantic tokens via `@theme` in `src/global.css`.
- **Icons (Astro):** `Icon` from `astro-icon/components`, loads from `src/icons/*.svg`.
- **Icons (Vue):** Import SVGs via `vite-svg-loader` with `?component` suffix. No `astro-icon` in Vue.
- **No inline `<svg>` markup** — store all SVGs in `src/icons/`.

## Error Handling

- **Trust the type system**: Skip defensive null checks when TS or DB constraints guarantee safety.
- **Deterministic error checking**: Use `error.code`/`error.status`, not string matching on messages.
- **Fail fast**: No silent fallbacks on unexpected errors.
- **Env vars**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.
- **DB is the integrity layer**: Enforce via constraints; front-end validation is UX-only.
- **Trust DB values**: No null checks for NOT NULL columns or FK-guaranteed data.

### Logging

- Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) — structured JSON with `timestamp`, `level`, `message`, `context`.
- Always pass a named context object (no `{}`/`undefined`).
- Expected rejections (auth failures, invalid input, rate limits) → `info`, not `warn`/`error`.

## Testing

- **Vitest only**. Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Scenario-based**: Each test represents a plausible user journey or system event, not abstract operations.
- **Integration over isolation**: Use real dependencies. Only mock external paid services (SES, Twilio, Finnhub).
- **Do not mock Supabase**: Use real client with seeded data via helpers in `tests/helpers/`.
- **Assert via behavior**: DB state, response payloads, status codes — not mock return values.
- **Realistic data**: Real tickers (AAPL, MSFT), realistic prices (187.42 not 100.0), real timezones.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.

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

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
