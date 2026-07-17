## Ship

Ship profile: `aws-sam`
Integration model: `pr-auto-merge`
CI owner: `github-handoff`
Production URL: <https://stocktextalerts.com>
Deploy deltas: Vercel Git owns the web tier; `.github/workflows/deploy.yml` owns production migrations, Lambda code, and live-provider verification after merge. `npm run deploy:code` is break-glass only; changes to `aws/template.yaml` or `aws/deploy.sh` require a manual `npm run deploy:infra`.
Repository-specific CI, branch-protection, and deploy behavior: [docs/github-ci.md](docs/github-ci.md).

## Commands

```bash
npm run dev
npm run dev:stop
npm run build
npm run check:biome
npm run check:ts
npm run check:knip
npm run check:sql
npm run check:md
npm run db:start
npm run db:reset
npm run db:bootstrap
npm run db:doctor
npm run db:gen-types
npm run worktree:provision
npm run worktree:init
supabase migration new <name> # Never rename migration timestamps
```

DB-backed test commands are explicit local opt-ins; follow the [local-tests skill](.claude/skills/local-tests/SKILL.md) and [tests/README.md](tests/README.md).

## Architecture and development

**StockTextAlerts** — securities notification platform sending scheduled email/Telegram updates for tracked US stocks and ETFs.

**Stack:** Astro 7 (SSR, Vite 8) on Vercel, Vue 3, Tailwind CSS 4, Supabase (PostgreSQL + Auth), AWS SES (email), Telegram (Bot API), Massive (batch snapshot quotes, bars/closes, calendar/holidays, movers, reference/universe, branding/logos, company news, corporate actions, delisting confirms), Finnhub (earnings calendar, recommendation trends, insider transactions), xAI/Grok (optional AI summaries).

- `src/pages/api/` owns HTTP APIs; `src/lib/` owns auth, DB, vendors, notification pipelines, messaging, scheduling, time, logging, and backups.
- `src/handlers/` contains Lambda entry points; `src/components/dashboard/` contains Vue panels/composables; `supabase/migrations/` is the schema source of truth.
- Local Supabase (Postgres + Auth + Mailpit at <http://127.0.0.1:54324>) should be running for dev; `predev` calls `db:doctor` non-fatally. Full repair is `npm run db:bootstrap`.
- Manual worktrees auto-run `worktree:provision` (copy `.env.local`, `npm ci`, mise) but never the destructive shared-stack reset in `worktree:init`.

See [docs/architecture-tiers.md](docs/architecture-tiers.md), [docs/tooling-setup.md](docs/tooling-setup.md), and [tests/README.md](tests/README.md).

## Project-specific style

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
- **Lambdas (`src/handlers/{delivery,maintenance}/*.ts`)** import `createLogger` from `src/lib/logging`. Each Lambda log group has an `AWS::Logs::MetricFilter` on `{ $.level = "error" }` feeding `stocktextalerts/ErrorLogCount` + `ErrorLogAlarm` (fires on any single error log line in a 1-minute window), alongside per-function `AWS/Lambda Errors` alarms.
- This logger is bespoke for Vue browser-bundle compatibility; it is not a sync consumer of `~/code/family-memory/src/shared/logging.ts`. Keep Lambda `LogFormat` unset; shared-infra SNS conventions: `~/code/shared-infra/docs/adding-a-project.md`.

## Supabase

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. The GitHub production deploy workflow (`.github/workflows/deploy.yml` → `aws/deploy-web.sh --deploy-ci`) runs `supabase db push` on push to `main` (i.e. after merge).
- **Apply migrations to production only via the GitHub deploy workflow's `supabase db push`**. Local-only paths: `supabase migration new <name>` then commit. (No MCP against prod, no manual `db push`, no dashboard DDL.)
- After changing a migration, run `npm run db:gen-types`; `src/lib/db/generated/database.types.ts` is generated and overwritten.
- **Notification options have ONE authored source: `NOTIFICATION_OPTION_MATRIX` in `src/lib/constants.ts`.** Every valid `(notification_type, content, channel)` option, its facet family, and its signup default is authored there; TS unions, the flat catalog + form field names, the form schema, signup/seed defaults, and dashboard bindings all derive from it. The `notification_options` DB table (FK'd from `notification_preferences`) is its DB twin: adding/removing/renaming an option = edit the matrix **plus** a migration syncing `notification_options`. `npm run check:option-catalog` (in `db:reset` + CI) fails on any drift between the table and the matrix; a dashboard E2E (`telegram-dashboard.e2e.spec.ts`) fails if the UI is missing a control for any catalog option.
- **Explicit grants required for functions, tables, and sequences.** `public` default privileges are empty in both local and production (parity established by `20260610182813_tighten_table_privileges`) — an object created without an explicit `GRANT` is usable by nobody but `postgres` (a missing function grant caused a duplicate-notification incident). Every migration that creates a Data-API (`.rpc(...)`) function must include `GRANT EXECUTE ON FUNCTION ... TO <role>` (server-only → `service_role`; session-scoped → `authenticated`, `service_role`) and the function must be classified in `scripts/db/privilege-contract.ts`. Every migration that creates a table or sequence must grant exactly what code needs (server-only → `service_role`; session-visible → `authenticated`/`anon`). `npm run check:db-privileges` (in `db:reset` + GitHub CI) and `npm run check:migration-grants` enforce the function side; `npm run audit:db-parity` diffs the full local permission structure against production (read-only). Test fixtures needing writes beyond prod grants use the `pg` client (`tests/helpers/asset-db.ts`), not `adminClient`. `supabase db diff` does not surface `ALTER DEFAULT PRIVILEGES`; review grants manually.

### Production DB agent block (enforced)

Agents never apply production schema migrations or migration-history repairs manually. Author migration files, validate locally, and let the GitHub deploy workflow apply them after merge. Treat `DATABASE_URL_PROD`, `SUPABASE_URL_PROD`, and project ref `japesagairjvvuebzpvr` as production.

The global dotagents `block-prod-db-migrations` guard is the cross-tool shell backstop; global permissions deny Supabase migration/SQL MCP tools where supported. Trusted Codex sessions also load `.codex/execpolicy.rules`. There is no repo-local Cursor runtime guard or enforced `cli.json`.

Read-only production inspection requires an explicit request and narrow queries without unnecessary PII. Production `UPDATE` / `INSERT` / `DELETE` requires approval for the exact operation, with a preflight read, narrow predicate, transaction when practical, and affected-row report; never use it for schema or migration-history changes. The global shell guard deliberately does not parse interactive `psql`.

Mark this repo trusted for Codex config loading. Migration-repair context: [docs/incidents/2026-05-migration-squash.md](docs/incidents/2026-05-migration-squash.md). Local-stack internals live in `scripts/db/`.

### Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS, providers, and CI

- Lambda code ships through `.github/workflows/deploy.yml`; local `deploy:code` is break-glass. Full SAM changes require manual `deploy:infra` with admin credentials. Copy `aws/samconfig.toml.example` to gitignored `aws/samconfig.toml`; never commit personal/admin profile names (`fleet-deploy` is the documented shared exception). Merge before a SAM deploy that changes env vars, or a later deploy from `main` will revert them.
- Provider calls are stubbed locally. Post-deploy, `stocktextalerts-live-provider-check` verifies Massive/Finnhub, a side-effect-free Telegram `getMe()`/`getWebhookInfo()`, and chart rendering; `agent-deploy` may invoke it manually for investigation. A real Telegram delivery remains a one-time human `/start` E2E.

Vendor clients live in `src/lib/vendors/` — Massive owns batch snapshot quotes, bars/closes, calendar/holidays, movers, reference/universe, branding/logos, company news, corporate actions (dividends/splits/IPOs), and per-symbol delisting confirms. Finnhub owns only the earnings calendar, recommendation trends, and insider transactions. xAI/Grok powers optional AI summaries.

**Massive Starter accepts quote data delayed by up to 15 minutes.** The scheduler still runs every minute for delivery precision; that cadence does not imply real-time quote freshness. Massive requests no longer use the old 5-calls/min proactive gate. Finnhub's residual capabilities remain behind the 55-calls/min per-process limiter (`finnhubFetch`). Jobs adding vendor calls must still budget against Lambda timeouts; the asset-maintenance handler guards each bounded step with `context.getRemainingTimeInMillis()` and skips with an error log when a step cannot fit. The full Massive universe reconcile runs daily (and probes branding for newly inserted listings); watchlist adds probe unchecked logos on demand. The confirm-based delisting sweep covers tracked symbols nightly.

**Telegram bot:** the **fleet-shared "SollyClaw"** identity (username `@SollyClawBot`, minted 2026-07-07 — it replaced `@StockTextAlertsBot`, which was deleted the same day, revoking that token; existing account links survived the swap because a private chat's ID is the user's Telegram ID, bot-independent — users just `/start` the new bot), owned by the user's **personal** Telegram account (deliberate at current scale; bot ownership is non-transferable — formalize a dedicated owner account **before ~50–100 linked users**, while re-linking is still cheap). **Shared-bot contract:** misc-notifications sends its morning briefing via the *same bot token*; this repo owns the bot's only webhook, so `/start` pairing, the command menu, and all inbound handling live here — `/stop`/`/unlink` gate *stock alerts only* (Supabase prefs), never the morning briefing (configured out-of-band in misc-notifications). Token rotation touches **three places**: `/stocktextalerts/telegram-bot-token` (SSM), `/misc-notifications/telegram-bot-token` (SSM), and the Vercel `TELEGRAM_BOT_TOKEN` env. The transport core (`src/lib/messaging/telegram/sender.ts` `createTelegramBot`) is the fleet-canonical reference; misc-notifications carries a documented copy. For Telegram-channel work, a first-class experience outranks dependency-minimalism (user decision 2026-06-19) — deps that materially improve UX are fine, overriding the general fewer-dependencies default. Candlestick charts render on Lambda via `@resvg/resvg-wasm` (pure WASM — the `.wasm` + Roboto TTFs ship into every bundle via `aws/chart-assets.sh` on both deploy paths, verified post-deploy by the live-provider-check `chart:render-png` step; see `docs/plans/2026-07-03-beautiful-telegram-notifications.md`).

- GitHub Actions owns the full test battery. The local pre-commit hook runs lint/types/static checks and the Lambda bundle only — no unit/E2E, local Supabase, or deploy. Schema-affecting web changes must stay backward-compatible until the parallel GitHub deploy applies migrations. Details and known flakes: [docs/github-ci.md](docs/github-ci.md).

- `agent-deploy` — scoped deploy role (S3, CloudFront, ECR, `lambda:UpdateFunctionCode`, `cloudformation:DescribeStackResource`, plus `lambda:InvokeFunction` on `*-live-provider-check` only — for the post-deploy live check). Used locally via the `fleet-deploy` profile for code-only deploys. Defined fleet-wide in `shared-infra/aws/template.yaml`.
- `github-actions-deploy` — scoped GitHub OIDC role for production code deploys from `birthmilk/stocktextalerts` on `main`. It reuses the code-only deploy policy and has no CloudFormation/SAM infra mutation permissions.
- `stocktextalerts-crons-*` — SAM-managed Lambda execution roles (auto-created; SES send via execution role, not static keys)

## Tooling, frontend, and security

- Production inspection, Vercel CLI, Mailpit, ports, and worktrees: [docs/tooling-setup.md](docs/tooling-setup.md). Cursor Cloud bootstrap: [docs/cursor-cloud.md](docs/cursor-cloud.md).
- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/display.ts`.
- Astro 7's Rust compiler and default `compressHTML: "jsx"` can change whitespace or reject invalid HTML; run `npm run build` after `.astro` edits.
- Vercel CDN caching uses `cacheVercel()` in `astro.config.ts`; the logo proxy uses `context.cache.set()`.
- Rate-limit env typing lives in `env.schema`; other secrets use `requireEnv()` from `src/lib/db/env.ts`. Keep file-based routes + middleware; `src/fetch.ts` is intentionally unused.
- `security.checkOrigin: false` delegates proxy-aware same-origin enforcement to `src/middleware.ts` (webhooks exempt). Set `ASTRO_SECURITY_CHECK_ORIGIN=true` to restore Astro enforcement.
- Runtime is Node 24.x via npm, not yarn/pnpm.

## Local UI verification

Auth-gated product UI. Follow `rules/frontend-verification.md` (fleet smoke: desktop + mobile screenshots, console clean).

- **Dev server:** `npm run dev` → <http://localhost:4321> (reuse if already up; `npm run dev:stop` to clear the Astro 7 lock). Local Supabase must be reachable (`npm run db:doctor` / `db:start`).
- **Sign-in:** `/auth/signin` with `DEFAULT_USER` and `DEFAULT_PASSWORD` from `.env.local` (see `env.example`). Seed default user is `dev@example.com` (pre-confirmed, pre-approved → `/dashboard`).
- **Do not** invent credentials or put `DEFAULT_USER` / `DEFAULT_PASSWORD` on Vercel.

## Cursor Cloud specific instructions

Full runbook: [docs/cursor-cloud.md](docs/cursor-cloud.md). The startup update script runs only `bash -lc 'npm ci'`; everything below is not automated and must be done in-session.

- **Node 24 via login shell:** `~/.bashrc` prepends the nvm Node 24 bin and exports `DOCKER_HOST=unix:///var/run/docker.sock`. Non-login shells (`bash -c`, `sh -c`) still resolve `/exec-daemon/node` (v22), which trips `engine-strict`. Run npm/dev/test/db commands through a login shell (`bash -lc '…'`) or a normal interactive terminal.
- **Docker daemon (once per fresh pod):** `sudo dockerd > /tmp/dockerd.log 2>&1 &`, then `docker info`. If the socket denies access, `sudo chmod 666 /var/run/docker.sock` (the `ubuntu` user is not always in the `docker` group on a fresh pod).
- **Docker 29 + fuse-overlayfs:** `/etc/docker/daemon.json` must set `"storage-driver": "fuse-overlayfs"` **and** `"features": { "containerd-snapshotter": false }` — Docker 29 defaults to the containerd snapshotter, which ignores the fuse-overlayfs driver this kernel needs. `docker info` should report `Storage Driver: fuse-overlayfs`.
- **Gitignored local files** (`.env.local`, `scripts/data/users.json`, `supabase/seed.sql`) persist via the snapshot, not the update script. If missing on a fresh pod: `cp scripts/data/sample-users.json scripts/data/users.json`, create `.env.local` from `env.example` (Supabase keys come from `supabase status -o json` after `npm run db:start` — map `ANON_KEY`→`SUPABASE_PUBLISHABLE_KEY`, `SERVICE_ROLE_KEY`→`SUPABASE_SECRET_KEY`, set `EMAIL_SMTP_HOST=localhost` and a local `DEFAULT_PASSWORD`), then `npm run db:generate-seed && npm run db:reset`.
- **Bring the stack up:** `npm run db:start` → `npm run db:reset` (reseed) → `npm run dev` (<http://localhost:4321>). `db:doctor`'s `auth container not inspectable (podman ENOENT)` warning is benign under Docker.
