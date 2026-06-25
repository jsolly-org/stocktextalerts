## Commands

```bash
npm run dev                # Dev server at http://localhost:4321
npm run build              # Production build
npm test                   # Vitest (requires local Supabase running)
npm run test:e2e           # Playwright E2E tests
npm run check:ts           # TypeScript check
npm run check:knip         # Find unused exports / files / dependencies
npm run check:biome        # Biome format + lint check
npm run db:start           # Start local Supabase (Docker/Podman)
npm run db:reset           # Reset DB: regenerate seed, apply migrations, regen types
npm run db:bootstrap       # Canonical first-run / "reset everything": link-worktree-data + db:start + db:reset + db:doctor
npm run worktree:provision # carry .env.local + npm ci + mise (cheap; what the post-checkout auto-runs)
npm run worktree:init      # worktree:provision + db:bootstrap (full first-run / "reset everything")
npm run db:doctor          # Preflight: auth reachable + seed user login probe (~300ms)
npm run db:gen-types       # Regenerate src/lib/db/generated/database.types.ts
supabase migration new <name>  # Create new migration (never rename timestamps)
```

**Single test file:** `npm test -- tests/lib/some-file.test.ts`
Run vitest via `npm test` so the npm script loads `.env.local` via `--env-file-if-exists`.

## Architecture

**StockTextAlerts** — securities notification platform sending scheduled SMS/email updates for tracked US stocks and ETFs.

**Stack:** Astro 5 (SSR) on Vercel, Vue 3, Tailwind CSS 4, Supabase (PostgreSQL + Auth), Twilio (SMS), AWS SES (email), Massive (prices + asset reference), Finnhub (earnings calendar + analyst/insider extras), xAI/Grok (optional AI summaries).

### Key Directories

- `src/pages/api/` — API endpoints (auth, assets, schedule, notifications)
- `src/lib/` — Server logic: `db/`, `auth/`, `providers/`, `market-notifications/`, `daily-digest/`, `asset-events/`, `messaging/`, `schedule/`, `time/`, `logging/`
- `src/components/dashboard/` — Vue dashboard panels with composables
- `supabase/migrations/` — SQL migrations (source of truth; the post-push deploy pushes to production)
- `tests/helpers/` — `test-user.ts`, `test-env.ts`, `asset-data.ts`

## Local development

- **Services for dev/test:** Local Supabase (Postgres + Auth + Mailpit at <http://127.0.0.1:54324>) must be running before `npm test` / `npm run dev` (`predev` / `pretest` call `db:doctor`). Start or repair with `npm run db:bootstrap`. Astro dev server: `npm run dev` → <http://localhost:4321>.
- **E2E:** Playwright uses port **4322** (`MODE=test npm run dev -- --port 4322`); ordinary browsing uses 4321.
- **Smoke checks:** `npm run check:biome`, `npm run check:ts`, `npm test` (needs Supabase), `npm run build`. Full browser E2E: `npm run test:e2e` (needs Playwright + Supabase + dev on 4322).

## Project-Specific Style

- **Biome** for all formatting/linting. `noConsole` is an error — use `src/lib/logging/` instead.
- **Astro files use the editor's built-in Astro formatter**; Biome handles everything else.
- **Tailwind utilities** over custom CSS. Semantic tokens via `@theme` in `src/global.css`.
- **Icons (Astro):** `Icon` from `astro-icon/components`, loads from `src/icons/*.svg`.
- **Icons (Vue):** Import SVGs via `vite-svg-loader` with `?component` suffix. No `astro-icon` in Vue.
- **No inline `<svg>` markup** — store all SVGs in `src/icons/`.
- **DB is the integrity layer**: Enforce via constraints; front-end validation is UX-only.

## Logging

- Use `src/lib/logging/` (`createLogger`, `rootLogger`) — structured JSON with `timestamp`, `level`, `message`, `context`. Always pass a named context object.
- **Env vars:** use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.
- **Lambdas (`src/handlers/*.ts`)** import `createLogger` from `src/lib/logging`. Each Lambda log group has an `AWS::Logs::MetricFilter` on `{ $.level = "error" }` feeding `stocktextalerts/ErrorLogCount` + `ErrorLogAlarm` (fires on any single error log line in a 1-minute window), alongside per-function `AWS/Lambda Errors` alarms.
- **This logger is bespoke** (Vue browser-bundle compatibility via a `process` guard) — NOT a sync consumer of `~/code/family-memory/src/shared/logging.ts`.
- Conventions (`LogFormat` unset, shared-infra SNS wiring): see `~/code/shared-infra/docs/adding-a-project.md`.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Use the real Supabase client** with seeded data via helpers in `tests/helpers/`. Exception: `formatPriceAlertSms` (async, hits the URL shortener) — see below.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- `formatPriceAlertSms` is **async** (shortens Grok link URLs via the `short_urls` table). Mock supabase for it must include a `.from().select().eq().gt().limit().single()` chain for the shortener dedup lookup. All other SMS formatters are sync.
- **No local live provider tests.** Provider keys (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) live in the Lambda runtime and are always stubbed in the local suite. `MASSIVE_API_KEY` is **also** present in the Vercel runtime — the logo endpoint (`src/pages/api/assets/logo/[symbol].ts`) reads it at request time; `TELEGRAM_BOT_TOKEN` is also on Vercel (the webhook reply); `FINNHUB_API_KEY`/`XAI_API_KEY` are Lambda-only. Real Massive/Finnhub round-trips — plus a **read-only Telegram token check** (`getMe()`/`getWebhookInfo()` only, never a send; `src/lib/messaging/telegram/health.ts`) — are validated in production by the scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/live-provider-check.ts`); invoke it with `aws lambda invoke` to test on demand. There is no local Telegram live-send target — the only real-message check is the one-time manual post-deploy `/start` E2E.
- **Test concurrency lock:** `npm test` and `npm run test:e2e` acquire a per-repo lock at `<git-common-dir>/test.lock` (cross-worktree). If another worktree is already running tests, the second invocation fails fast with a message identifying the holder. Stale locks (dead PID) are taken over silently. Force-clear with `rm $(git rev-parse --git-common-dir)/test.lock` if you're sure the holder is dead.
- **Fresh worktree?** A committed `.git-hooks/post-checkout` now AUTO-provisions a manual `git worktree add` (via dotagents' shared provisioner it runs `npm run worktree:provision` — carry `.env.local` + real `npm ci` + mise; never symlink `node_modules`, Vite `server.fs.allow` 403s on a symlink). For a first run that also needs the local DB seeded, run `npm run worktree:init` (`worktree:provision` + `db:bootstrap`) — the post-checkout deliberately runs only `worktree:provision`, NOT `worktree:init`, so a routine worktree add never triggers `db:bootstrap`'s destructive reset of the shared stack. A new worktree branches from `origin/main` and lacks gitignored `.env.local` + `scripts/data/users.json` and `node_modules`. **All worktrees share ONE local Supabase stack** (default ports, project_id `stocktextalerts`); the cross-worktree `test.lock` serializes DB access (a second `npm test` waits), and `db:reset` acquires that lock so it can't reset the shared DB under another worktree's running suite. `.env.local` is copied (not port-patched) — the shared default ports are already correct. Migrating an old per-worktree-stack worktree: `npm run db:collapse-worktree-stacks` (dry-run; `-- --apply` to execute). See `docs/local-supabase.md`.

See `docs/testing.md` for the production-credential gating model and Mailpit dev/test routing.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. The post-push deploy (`npm run deploy:code` → `aws/deploy-web.sh`, run after the push lands) runs `supabase db push`.
- **Apply migrations to production only via the deploy's `supabase db push`** (`npm run deploy:code`, post-push). Local-only paths: `supabase migration new <name>` then commit. (No MCP against prod, no manual `db push`, no dashboard DDL.)
- After creating/modifying a migration: `npm run db:gen-types`.
- **Regenerate `src/lib/db/generated/database.types.ts` via `npm run db:gen-types`** — it's overwritten on every run.
- **Explicit grants required for functions, tables, and sequences.** `public` default privileges are empty in both local and production (parity established by `20260610182813_tighten_table_privileges`) — an object created without an explicit `GRANT` is usable by nobody but `postgres` (a missing function grant caused the duplicate-SMS incident). Every migration that creates a Data-API (`.rpc(...)`) function must include `GRANT EXECUTE ON FUNCTION ... TO <role>` (server-only → `service_role`; session-scoped → `authenticated`, `service_role`) and the function must be classified in `scripts/db/privilege-contract.ts`. Every migration that creates a table or sequence must grant exactly what code needs (server-only → `service_role`; session-visible → `authenticated`/`anon`). `npm run check:db-privileges` (in `db:reset` + the pre-push gate) and `npm run check:migration-grants` enforce the function side; `npm run audit:db-parity` diffs the full local permission structure against production (read-only). Test fixtures needing writes beyond prod grants use the `pg` client (`tests/helpers/asset-db.ts`), not `adminClient`. `supabase db diff` does not surface `ALTER DEFAULT PRIVILEGES`; review grants manually. See `docs/local-supabase.md` → "Function & table privilege parity".

### Production DB agent block (enforced)

Agents (Cursor, Claude Code, Codex) **must not** apply production Supabase schema migrations manually. Read-only production inspection is allowed when the user asks for it. Direct production data writes are not forbidden, but they require explicit user approval for the exact operation and should be narrow, auditable, and preferably reversible. Runtime guards in `.cursor/`, `.claude/`, and `.codex/` block the dangerous paths; policy text alone is not enough.

**Never run or invoke:**

- `supabase db push` (production apply happens only inside the post-push deploy `npm run deploy:code` → `aws/deploy-web.sh`, after the push lands — never run it by hand)
- `supabase migration repair` against linked/production (human runbook only — see `docs/incidents/2026-05-migration-squash.md`)
- `psql` using production credentials for writes, DDL, migrations, repairs, or ad hoc data fixes (`DATABASE_URL_PROD`, `SUPABASE_URL_PROD`, project ref `japesagairjvvuebzpvr`, etc.)
- Supabase MCP `apply_migration` against production
- Supabase MCP `execute_sql` against production for writes, DDL, migrations, repairs, or ad hoc data fixes

**Allowed production DB inspection:** read-only `SELECT` queries through approved tooling (Supabase MCP `execute_sql` or `psql`) when the user explicitly asks for production verification. Keep these queries narrow, avoid selecting secrets or unnecessary user PII, and never mutate data.

**Allowed production data fixes:** direct `UPDATE` / `INSERT` / `DELETE` only when the user explicitly approves the exact statement or well-scoped operation in the current conversation. Prefer a transaction, include a preflight `SELECT`, report affected row counts, and avoid broad predicates. Never use this path for schema changes or migration history changes.

**Allowed agent workflow:** `supabase migration new <name>` → edit `supabase/migrations/*.sql` → `npm run db:reset` / `db:gen-types` → commit → push to `main` → `npm run deploy:code` (the post-push deploy runs `supabase db push`).

**Codex:** mark this repo as a **trusted** project so `.codex/config.toml` and `.codex/execpolicy.rules` load (see [Codex config basics](https://developers.openai.com/codex/config-basic)).

See `docs/local-supabase.md` for `db:bootstrap`, seed hardening, and Podman setup.

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

Lambda **code** ships via **`npm run deploy:code`** (`aws/deploy-web.sh`, scoped `fleet-deploy` role) run **after the push lands** (by `/ship`, or by hand) — **not inside the pre-push hook**. The hook only GATES the landing; `deploy-web.sh` calls **`gate_require_landed`** and fails closed unless `HEAD == origin/main`, so a deploy can never ship code that hasn't landed (the 2026-06-24 concurrent-push race). A **full SAM deploy** is still required when changing `aws/template.yaml` or `aws/deploy.sh` (infra/config): run `npm run deploy:infra` manually with admin creds. Copy `aws/samconfig.toml.example` → gitignored `aws/samconfig.toml`; use `AWS_PROFILE` locally. Never commit personal/admin AWS profile names in tracked files (the shared fleet convention `fleet-deploy` is the documented exception).

### Post-deploy live verification (no local live-test tier)

Provider keys live in the Lambda runtime (and `MASSIVE_API_KEY` also in Vercel, for the logo endpoint), so the local suite stubs every external call and cannot catch a real-API regression. After a push+deploy whose diff touched **live-affecting code** — `src/lib/providers/`, the provider clients, response parsing, auth/scoping, retry/timeout, notification content built from live data, or the Telegram bot/token path — **manually invoke the scheduled `stocktextalerts-live-provider-check` Lambda** (`src/handlers/live-provider-check.ts`) with `aws lambda invoke` and confirm it succeeds (no thrown error / no `LiveProviderCheckFunctionErrorAlarm`). This Lambda also runs the **read-only Telegram token check** (`getMe()`/`getWebhookInfo()`, side-effect-free — never a send), so it doubles as the Telegram live-verification step. This is `/ship`'s post-deploy live-verification step for this repo. Run it during market hours when snapshot data is fresh. The `fleet-deploy` profile (`agent-deploy` role) is scoped to invoke `*-live-provider-check`, so an agent can run this directly — no admin step-up. Confirming a real Telegram message actually *lands* is a separate one-time manual `/start` E2E (a human-only real send, never automated).

## External APIs

See `docs/external-apis.md` for Massive (prices/reference) and Finnhub (earnings calendar + extras).

## CI on push to main (local pre-push gate)

The pre-push hook (`.git-hooks/pre-push`, the committed gate) runs the full CI battery on push to `main` — **gate-only; it does not deploy**. The deploy is a separate post-landing step (`npm run deploy:code`, run by `/ship` after the push lands, or by hand). See `docs/prepush-gate.md` for the command list. The gate needs local Supabase up (`npm run db:start`).

**The gate only runs on local pushes.** Server-side merges (GitHub UI merge button, Dependabot merges) bypass the CI gate, and nothing triggers the post-push `npm run deploy:code` — merge PRs locally and push (then deploy) instead. Cloud VMs have no deploy credentials: push feature branches only from cloud; pushes to `main` happen from a credentialed laptop.

## AWS IAM

- `agent-deploy` — scoped deploy role (S3, CloudFront, ECR, `lambda:UpdateFunctionCode`, `cloudformation:DescribeStackResource`, plus `lambda:InvokeFunction` on `*-live-provider-check` only — for the post-deploy live check). Used locally via the `fleet-deploy` profile for code-only deploys. Defined fleet-wide in `shared-infra/aws/template.yaml`.
- `stocktextalerts-crons-*` — SAM-managed Lambda execution roles (auto-created; SES send via execution role, not static keys)

## Tooling Setup

See `docs/tooling-setup.md` for Production Supabase access (psql, env vars, project ref), Vercel CLI scope, and Mailpit dev email routing.

## Deploy gotchas

- **Merge to main before SAM deploy that changes env vars.** See `docs/deploy-gotchas.md`.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
