@.agents/AGENTS.md

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
npm run db:bootstrap       # Canonical first-run / "reset everything": link-worktree-data + worktree-setup + db:start + db:reset + db:doctor
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

## Cursor Cloud

Cloud agents: see `.agents/docs/cloud-agents.md` (fleet layout, subtree updates). Supabase/Docker bootstrap on cloud VMs: `docs/cloud-supabase-bootstrap.md`.

## Cursor Cloud specific instructions

- **First boot:** `.cursor/environment.json` runs `bash scripts/cloud-agent-install.sh` (Node 24 via nvm, `npm ci`, Docker, Supabase, `.env.local`, `db:reset`, `db:doctor`, then Playwright E2E browsers). Supabase runs before Playwright so unit tests work even when browser install stalls. See `docs/cloud-supabase-bootstrap.md` for Docker/iptables/Playwright gotchas. Node PATH: `.agents/docs/cloud-agents.md`.
- **Node on PATH:** Cloud VMs ship Node 22 on PATH; install adds an `~/.bashrc` marker so interactive shells prefer Node 24 from nvm. Non-interactive commands should `source ~/.nvm/nvm.sh && nvm use 24` (or rely on a new shell after install). Fleet doc: `.agents/docs/cloud-agents.md` → **Node on PATH**.
- **Docker socket:** If `docker info` fails with permission denied after install, run `sudo chmod 666 /var/run/docker.sock` once, then `npm run db:start` if Supabase containers are down.
- **Services for dev/test:** Local Supabase (Postgres + Auth + Mailpit at <http://127.0.0.1:54324>) must be running before `npm test` / `npm run dev` ( `predev` / `pretest` call `db:doctor`). Start or repair with `npm run db:bootstrap`. Astro dev server: `npm run dev` → <http://localhost:4321> (`.cursor/environment.json` may auto-start a `dev` terminal).
- **E2E:** Playwright uses port **4322** (`MODE=test npm run dev -- --port 4322`); cloud install sets `VERCEL_URL=http://localhost:4322` in `.env.local` for that path. Ordinary browsing uses 4321.
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
- Conventions (`LogFormat` unset, alert-hub SNS wiring): see `~/code/alert-hub/docs/adding-a-project.md`.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Use the real Supabase client** with seeded data via helpers in `tests/helpers/`. Exception: `formatPriceAlertSms` (async, hits the URL shortener) — see below.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- `formatPriceAlertSms` is **async** (shortens Grok link URLs via the `short_urls` table). Mock supabase for it must include a `.from().select().eq().gt().limit().single()` chain for the shortener dedup lookup. All other SMS formatters are sync.
- **Live API tests**: `npm run test:live:email`, `test:live:data`, `test:live:xai`, `test:live:all`. Always reproduce live test failures locally before fixing.
- **Test concurrency lock:** `npm test` and `npm run test:e2e` acquire a per-repo lock at `<git-common-dir>/test.lock` (cross-worktree). If another worktree is already running tests, the second invocation fails fast with a message identifying the holder. Stale locks (dead PID) are taken over silently. Force-clear with `rm $(git rev-parse --git-common-dir)/test.lock` if you're sure the holder is dead.

See `docs/testing.md` for the production-credential gating model and Mailpit dev/test routing.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. CI runs `supabase db push`.
- **Apply migrations to production only via CI's `supabase db push`.** Local-only paths: `supabase migration new <name>` then commit. (No MCP against prod, no `db push` locally, no dashboard DDL.)
- After creating/modifying a migration: `npm run db:gen-types`.
- **Regenerate `src/lib/db/generated/database.types.ts` via `npm run db:gen-types`** — it's overwritten on every run.

### Production DB agent block (enforced)

Agents (Cursor, Claude Code, Codex) **must not** apply production Supabase schema migrations manually. Read-only production inspection is allowed when the user asks for it. Direct production data writes are not forbidden, but they require explicit user approval for the exact operation and should be narrow, auditable, and preferably reversible. Runtime guards in `.cursor/`, `.claude/`, and `.codex/` block the dangerous paths; policy text alone is not enough.

**Never run or invoke:**

- `supabase db push` (production apply is only in `.github/workflows/deploy.yml` after merge to `main`)
- `supabase migration repair` against linked/production (human runbook only — see `docs/incidents/2026-05-migration-squash.md`)
- `psql` using production credentials for writes, DDL, migrations, repairs, or ad hoc data fixes (`DATABASE_URL_PROD`, `SUPABASE_URL_PROD`, project ref `japesagairjvvuebzpvr`, etc.)
- Supabase MCP `apply_migration` against production
- Supabase MCP `execute_sql` against production for writes, DDL, migrations, repairs, or ad hoc data fixes

**Allowed production DB inspection:** read-only `SELECT` queries through approved tooling (Supabase MCP `execute_sql` or `psql`) when the user explicitly asks for production verification. Keep these queries narrow, avoid selecting secrets or unnecessary user PII, and never mutate data.

**Allowed production data fixes:** direct `UPDATE` / `INSERT` / `DELETE` only when the user explicitly approves the exact statement or well-scoped operation in the current conversation. Prefer a transaction, include a preflight `SELECT`, report affected row counts, and avoid broad predicates. Never use this path for schema changes or migration history changes.

**Allowed agent workflow:** `supabase migration new <name>` → edit `supabase/migrations/*.sql` → `npm run db:reset` / `db:gen-types` → commit → merge → CI `supabase db push`.

**Codex:** mark this repo as a **trusted** project so `.codex/config.toml` and `.codex/execpolicy.rules` load (see [Codex config basics](https://developers.openai.com/codex/config-basic)).

**Cursor hooks:** `.cursor/hooks.json` uses matchers so guards do not run on every shell command. After a fleet subtree sync, re-apply repo guard wiring if hooks regress: `bash scripts/merge-cursor-agent-guards.sh`.

See `docs/local-supabase.md` for `db:bootstrap`, seed hardening, and Podman setup.

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

**SAM deploy required** when committing changes to `aws/template.yaml`, `aws/deploy.sh`, `src/handlers/`, or `src/lib/`. After the commit: `cd aws && npm run deploy` (or `npm run deploy:aws` from repo root). Copy `aws/samconfig.toml.example` → gitignored `aws/samconfig.toml`; use `AWS_PROFILE` locally. Never commit AWS profile names in tracked files.

## External APIs

See `docs/external-apis.md` for Massive (prices/reference) and Finnhub (earnings calendar + extras).

## CI before push to main

Pre-commit hooks (`.githooks/pre-commit`) mirror the deploy workflow `run-ci` step. See `docs/ci-with-act.md` for the full local command list and the 7-item pre-push checklist. Deploy on `main` is the GitHub guard (production creds); it is not runnable locally.

## AWS IAM

- `GitHubActionsDeploymentRole` — OIDC role for GitHub Actions CI (S3, CloudFront, ECR, Lambda, CloudFormation)
- `stocktextalerts-crons-*` — SAM-managed Lambda execution roles (auto-created; SES send via execution role, not static keys)

## Tooling Setup

See `docs/tooling-setup.md` for Production Supabase access (psql, env vars, project ref), Vercel CLI scope, Cloudflare CLI auth, and Mailpit dev email routing.

## Deploy gotchas

- **Merge to main before SAM deploy that changes env vars.** See `docs/deploy-gotchas.md`.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
