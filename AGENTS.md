## Ship

Ship profile: `aws-sam`

**Integration: branch → PR → CI-gated auto-merge (canonical).** Push your work on a branch (a `git worktree` keeps it off your main checkout — optional, and does nothing for CI by itself), open a PR, and let auto-merge (`gh pr merge --auto --squash`, wired in `auto-merge.yml`) land it once the required strict **`ci`** check is green. This keeps GitHub CI (full unit/E2E/build — which the local pre-push hook does *not* run) a real gate on `main`. Branch protection requires a PR + the `ci` check. See the [CI](#ci-github-actions--local-pre-push-gate) section for the full model.

`/ship`'s direct push to `main` is **break-glass only** here: as repo admin (`enforce_admins` off) it *bypasses* the required `ci` check, landing code before CI runs (git prints a "Bypassed rule violations" warning). Reach for it only in an emergency that can't wait for the PR pipeline — the normal path is a PR so CI gates the merge.

**Post-push (step 12):** Production deploy is **GitHub-managed** — after push to `main`, CI then `.github/workflows/deploy.yml` runs migrations, Lambda updates, and the live-provider check. Babysit those workflows; local `npm run deploy:code` is break-glass only. Vercel deploys the web tier via Git integration — verify production if web paths changed. Run `npm run deploy:infra` manually (human MFA) when `aws/template.yaml` or `aws/deploy.sh` changes — never auto-run from `/ship`.

Local gate before push: pre-push hook steps in `.git-hooks/pre-push` (biome, yaml/actionlint, `check:ts`, knip, squawk SQL lint, deploy-fn coverage, static migration grants, and a fail-fast Lambda bundle build via `aws/deploy-web.sh --build`; unit tests run in GitHub CI, not the hook).

## Commands

```bash
npm run dev                # Dev server at http://localhost:4321
npm run dev:stop           # Stop Astro 7 background dev server / clear lock
npm run build              # Production build
npm test                   # Vitest — blocked locally unless ALLOW_LOCAL_DB_TESTS=1 (CI is canonical)
npm run test:local         # Local opt-in + auto preflight (Podman start, db:doctor, db:start retry)
npm run test:e2e           # Playwright E2E — same opt-in
npm run test:e2e:local     # E2E opt-in + auto preflight (like test:local)
npm run check:ts           # TypeScript check
npm run check:knip         # Find unused exports / files / dependencies
npm run check:biome        # Biome format + lint check
npm run check:sql          # Squawk lint on supabase/migrations/*.sql
npm run check:md           # markdownlint (check:md:fix to auto-fix)
npm run db:start           # Start local Supabase (Docker/Podman)
npm run db:reset           # Reset DB: regenerate seed, apply migrations, regen types
npm run db:bootstrap       # Canonical first-run / "reset everything": link-worktree-data + db:start + db:reset + db:doctor
npm run worktree:provision # carry .env.local + npm ci + mise (cheap; what the post-checkout auto-runs)
npm run worktree:init      # worktree:provision + db:bootstrap (full first-run / "reset everything")
npm run db:doctor          # Preflight: auth reachable + seed user login probe (~300ms)
npm run db:gen-types       # Regenerate src/lib/db/generated/database.types.ts
supabase migration new <name>  # Create new migration (never rename timestamps)
```

**Single test file (debugging only):** `ALLOW_LOCAL_DB_TESTS=1 npm test -- tests/lib/some-file.test.ts` (or `npm run test:local -- tests/lib/some-file.test.ts`)
Run vitest via `npm test` so the npm script loads `.env.local` via `--env-file-if-exists`. Do **not** run local DB tests as a merge gate — wait for GitHub CI.

## Architecture

**StockTextAlerts** — securities notification platform sending scheduled SMS/email updates for tracked US stocks and ETFs.

**Stack:** Astro 7 (SSR, Vite 8) on Vercel, Vue 3, Tailwind CSS 4, Supabase (PostgreSQL + Auth), Twilio (SMS), AWS SES (email), Massive (prices + asset reference), Finnhub (earnings calendar + analyst/insider extras), xAI/Grok (optional AI summaries).

### Key Directories

- `src/pages/api/` — API endpoints (auth, assets, schedule, notifications)
- `src/lib/` — Server logic: `db/`, `auth/`, `vendors/` (Massive/Finnhub/xAI clients), notification pipelines (`market-notifications/`, `daily-digest/`, `daily-notification/`, `asset-events/`, `price-alerts/`, `staged-notifications/`, `scheduled-notifications/`), `messaging/` (email/SMS/Telegram), `schedule/`, `time/`, `logging/`, `backup/`
- `src/handlers/` — AWS Lambda entry points (cron, SQS, signed email dispatch)
- `src/components/dashboard/` — Vue dashboard panels with composables
- `supabase/migrations/` — SQL migrations (source of truth; the post-push deploy pushes to production)
- `tests/helpers/` — `test-user.ts`, `test-env.ts`, `asset-data.ts`

See [docs/architecture-tiers.md](docs/architecture-tiers.md) for when code belongs on Vercel vs Lambda.

## Local development

- **Services for dev/test:** Local Supabase (Postgres + Auth + Mailpit at <http://127.0.0.1:54324>) must be running before `npm run dev` (`predev` calls `db:doctor`, failures are non-fatal). DB-backed tests (`npm test`, `npm run test:e2e`) are **blocked locally unless `ALLOW_LOCAL_DB_TESTS=1`** — GitHub CI is the canonical runner. Prefer `npm run test:local` / `npm run test:e2e:local` (opt-in + auto preflight: Podman start, `db:doctor`, `db:start` retry). Full repair when preflight still fails: `npm run db:bootstrap`. Astro dev server: `npm run dev` → <http://localhost:4321>. Astro 7 dev lock: `npm run dev:stop` / `astro dev stop` before opt-in E2E or when tests contend on `.astro/dev.json`.
- **E2E:** Playwright uses port **4322** (`MODE=test npm run dev -- --port 4322`); preview E2E uses **4323** (`npm run test:e2e:preview`). See `docs/tooling-setup.md` for the full port map.
- **Smoke checks:** `npm run check:biome`, `npm run check:ts`, `npm run build`. Full test battery runs in GitHub CI — local `npm test` / E2E require `ALLOW_LOCAL_DB_TESTS=1` (debugging only).

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
- **Lambdas (`src/handlers/{delivery,maintenance}/*.ts`)** import `createLogger` from `src/lib/logging`. Each Lambda log group has an `AWS::Logs::MetricFilter` on `{ $.level = "error" }` feeding `stocktextalerts/ErrorLogCount` + `ErrorLogAlarm` (fires on any single error log line in a 1-minute window), alongside per-function `AWS/Lambda Errors` alarms.
- **This logger is bespoke** (Vue browser-bundle compatibility via a `process` guard) — NOT a sync consumer of `~/code/family-memory/src/shared/logging.ts`.
- Conventions (`LogFormat` unset, shared-infra SNS wiring): see `~/code/shared-infra/docs/adding-a-project.md`.

## Testing (Project-Specific)

**Scope:** The local DB test opt-in (`ALLOW_LOCAL_DB_TESTS`), `test:local` preflight chain, and `.cursor/skills/local-tests` are **StockTextAlerts-only** — shared Supabase stack, Podman wiring, and CI-as-canonical model for this repo. Fleet-wide agent conventions (skills distribution, `/ship`, tool hygiene) live in `~/code/dotagents`; other repos do not copy this test guard unless they document the same pattern.

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Use the real Supabase client** with seeded data via helpers in `tests/helpers/`.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `src/lib/db/schema-version.ts`.
- All SMS formatters are sync.
- **No local live provider tests.** Provider keys (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) live in the Lambda runtime and are always stubbed in the local suite. `MASSIVE_API_KEY` is **also** present in the Vercel runtime — the logo endpoint (`src/pages/api/assets/logo/[symbol].ts`) reads it at request time; `TELEGRAM_BOT_TOKEN` is also on Vercel (the webhook reply); `FINNHUB_API_KEY`/`XAI_API_KEY` are Lambda-only. Real Massive/Finnhub round-trips — plus a **read-only Telegram token check** (`getMe()`/`getWebhookInfo()` only, never a send; `src/lib/messaging/telegram/health.ts`) — are validated in production by the scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/maintenance/live-provider-check.ts`); invoke it with `aws lambda invoke` to test on demand. There is no local Telegram live-send target — the only real-message check is the one-time manual post-deploy `/start` E2E.
- **Test concurrency lock:** When `ALLOW_LOCAL_DB_TESTS=1`, `npm test` and `npm run test:e2e` acquire a per-repo lock at `<git-common-dir>/test.lock` (cross-worktree). If another worktree is already running tests, the runner waits **2 minutes** and retries, up to **3 attempts** total, before printing the contention banner and exiting. Stale locks (dead PID) are taken over silently on the next attempt. **Agents:** do not run local DB tests unless the user explicitly opts in (`ALLOW_LOCAL_DB_TESTS=1` or `npm run test:local` / `test:e2e:local`); prefer those wrappers so preflight repairs Podman/Supabase first. Let the retry loop run if they do — do not force-clear the lock or spawn parallel test runs while waiting. If all 3 attempts fail, stop and report the contention message to the user (another worktree's suite is still running). Force-clear only when you're sure the holder PID is dead: `rm $(git rev-parse --git-common-dir)/test.lock`.
- **Fresh worktree?** A committed `.git-hooks/post-checkout` now AUTO-provisions a manual `git worktree add` (via dotagents' shared provisioner it runs `npm run worktree:provision` — carry `.env.local` + real `npm ci` + mise; never symlink `node_modules`, Vite `server.fs.allow` 403s on a symlink). For a first run that also needs the local DB seeded, run `npm run worktree:init` (`worktree:provision` + `db:bootstrap`) — the post-checkout deliberately runs only `worktree:provision`, NOT `worktree:init`, so a routine worktree add never triggers `db:bootstrap`'s destructive reset of the shared stack. A new worktree branches from `origin/main` and lacks gitignored `.env.local` + `scripts/data/users.json` and `node_modules`. **All worktrees share ONE local Supabase stack** (default ports, project_id `stocktextalerts`); the cross-worktree `test.lock` serializes DB access (a second `npm test` waits), and `db:reset` acquires that lock so it can't reset the shared DB under another worktree's running suite. `.env.local` is copied (not port-patched) — the shared default ports are already correct. Migrating an old per-worktree-stack worktree: `npm run db:collapse-worktree-stacks` (dry-run; `-- --apply` to execute).

See `tests/README.md` for the production-credential gating model and Mailpit dev/test routing.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. The GitHub production deploy workflow (`.github/workflows/deploy.yml` → `aws/deploy-web.sh --deploy-ci`) runs `supabase db push` after `main` CI passes.
- **Apply migrations to production only via the GitHub deploy workflow's `supabase db push`**. Local-only paths: `supabase migration new <name>` then commit. (No MCP against prod, no manual `db push`, no dashboard DDL.)
- After creating/modifying a migration: `npm run db:gen-types`.
- **Regenerate `src/lib/db/generated/database.types.ts` via `npm run db:gen-types`** — it's overwritten on every run.
- **Notification options have ONE authored source: `NOTIFICATION_OPTION_MATRIX` in `src/lib/constants.ts`.** Every valid `(notification_type, content, channel)` option, its facet family, and its signup default is authored there; TS unions, the flat catalog + form field names, the form schema, the SMS opt-out guard, signup/seed defaults, and dashboard bindings all derive from it. The `notification_options` DB table (FK'd from `notification_preferences`) is its DB twin: adding/removing/renaming an option = edit the matrix **plus** a migration syncing `notification_options`. `npm run check:option-catalog` (in `db:reset` + CI) fails on any drift between the table and the matrix; a dashboard E2E (`telegram-dashboard.e2e.spec.ts`) fails if the UI is missing a control for any catalog option.
- **Explicit grants required for functions, tables, and sequences.** `public` default privileges are empty in both local and production (parity established by `20260610182813_tighten_table_privileges`) — an object created without an explicit `GRANT` is usable by nobody but `postgres` (a missing function grant caused the duplicate-SMS incident). Every migration that creates a Data-API (`.rpc(...)`) function must include `GRANT EXECUTE ON FUNCTION ... TO <role>` (server-only → `service_role`; session-scoped → `authenticated`, `service_role`) and the function must be classified in `scripts/db/privilege-contract.ts`. Every migration that creates a table or sequence must grant exactly what code needs (server-only → `service_role`; session-visible → `authenticated`/`anon`). `npm run check:db-privileges` (in `db:reset` + GitHub CI) and `npm run check:migration-grants` enforce the function side; `npm run audit:db-parity` diffs the full local permission structure against production (read-only). Test fixtures needing writes beyond prod grants use the `pg` client (`tests/helpers/asset-db.ts`), not `adminClient`. `supabase db diff` does not surface `ALTER DEFAULT PRIVILEGES`; review grants manually.

### Production DB agent block (enforced)

Agents (Cursor, Claude Code, Codex) **must not** apply production Supabase schema migrations manually. Read-only production inspection is allowed when the user asks for it. Direct production data writes are not forbidden, but they require explicit user approval for the exact operation and should be narrow, auditable, and preferably reversible. Runtime guards in `.cursor/`, `.claude/`, and `.codex/` block the dangerous paths; policy text alone is not enough.

**Never run or invoke:**

- `supabase db push` (production apply happens only inside the GitHub production deploy workflow — never run it by hand)
- `supabase migration repair` against linked/production (human runbook only — see `docs/incidents/2026-05-migration-squash.md`)
- `psql` using production credentials for writes, DDL, migrations, repairs, or ad hoc data fixes (`DATABASE_URL_PROD`, `SUPABASE_URL_PROD`, project ref `japesagairjvvuebzpvr`, etc.)
- Supabase MCP `apply_migration` against production
- Supabase MCP `execute_sql` against production for writes, DDL, migrations, repairs, or ad hoc data fixes

**Allowed production DB inspection:** read-only `SELECT` queries through approved tooling (Supabase MCP `execute_sql` or `psql`) when the user explicitly asks for production verification. Keep these queries narrow, avoid selecting secrets or unnecessary user PII, and never mutate data.

**Allowed production data fixes:** direct `UPDATE` / `INSERT` / `DELETE` only when the user explicitly approves the exact statement or well-scoped operation in the current conversation. Prefer a transaction, include a preflight `SELECT`, report affected row counts, and avoid broad predicates. Never use this path for schema changes or migration history changes.

**Allowed agent workflow:** `supabase migration new <name>` → edit `supabase/migrations/*.sql` → `npm run db:reset` / `db:gen-types` → commit → integrate via branch → PR → auto-merge (see Ship section); `/ship` direct-push is break-glass only → `main` CI → GitHub production deploy (the deploy workflow runs `supabase db push`).

**Codex:** mark this repo as a **trusted** project so `.codex/config.toml` and `.codex/execpolicy.rules` load (see [Codex config basics](https://developers.openai.com/codex/config-basic)).

Local-stack internals (`db:bootstrap`, seed hardening, Podman/container-engine wiring) live in `scripts/db/` — the scripts are the documentation.

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

Lambda **code** ships via the GitHub production deploy workflow (`.github/workflows/deploy.yml` → `aws/deploy-web.sh --deploy-ci`) after the landed `main` commit passes CI. The local `npm run deploy:code` path remains break-glass only. A **full SAM deploy** is still required when changing `aws/template.yaml` or `aws/deploy.sh` (infra/config): run `npm run deploy:infra` manually with admin creds. Copy `aws/samconfig.toml.example` → gitignored `aws/samconfig.toml`; use `AWS_PROFILE` locally. Never commit personal/admin AWS profile names in tracked files (the shared fleet convention `fleet-deploy` is the documented exception).

### Post-deploy live verification (no local live-test tier)

Provider keys live in the Lambda runtime (and `MASSIVE_API_KEY` also in Vercel, for the logo endpoint), so the local suite stubs every external call and cannot catch a real-API regression. The GitHub production deploy workflow invokes the scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/maintenance/live-provider-check.ts`) after every deploy and fails red on any thrown error. This Lambda also runs the **read-only Telegram token check** (`getMe()`/`getWebhookInfo()`, side-effect-free — never a send), so it doubles as the Telegram live-verification step. Manual on-demand invokes are still allowed for investigation with the scoped deploy role. Confirming a real Telegram message actually *lands* is a separate one-time manual `/start` E2E (a human-only real send, never automated).

## External APIs

Vendor clients live in `src/lib/vendors/` — Massive (prices, asset reference, dividends/splits/IPOs) and Finnhub (symbols, earnings calendar, market hours, analyst/insider extras). xAI/Grok powers optional AI summaries.

**Telegram bot:** `@StockTextAlertsBot`, owned by the user's **personal** Telegram account (deliberate at current scale; bot ownership is non-transferable — formalize a dedicated owner account **before ~50–100 linked users**, while re-linking is still cheap). For Telegram-channel work, a first-class experience outranks dependency-minimalism (user decision 2026-06-19) — deps that materially improve UX are fine, overriding the general fewer-dependencies default. Candlestick charts render on Lambda via `@resvg/resvg-wasm` (pure WASM — the `.wasm` + Roboto TTFs ship into every bundle via `aws/chart-assets.sh` on both deploy paths, verified post-deploy by the live-provider-check `chart:render-png` step; see `docs/plans/2026-07-03-beautiful-telegram-notifications.md`).

## CI (GitHub Actions + local pre-push gate)

GitHub Actions runs the full test battery on PRs, merge queue entries if the feature becomes available, and `main` pushes (`.github/workflows/ci.yml`); auto-merge is enabled by `.github/workflows/auto-merge.yml` once required checks pass. Native GitHub Merge Queue is currently unavailable for this private GitHub Team repository (GitHub rejects the rule through API and the UI does not expose it). The production deploy workflow (`.github/workflows/deploy.yml`) runs after `main` CI succeeds. Vercel's GitHub integration owns the production web deploy; Actions owns Supabase migrations, Lambda code updates, and live-provider verification. See `docs/github-ci.md` for branch protection, environment secrets, and deploy setup.

Because Vercel Git deployments start independently on `main` pushes, schema-affecting web changes must remain backward-compatible with the currently deployed database until the GitHub deploy workflow has applied migrations. Use the local break-glass `npm run deploy:code` path only when an explicitly ordered DB/Lambda/web release is required.

The pre-push hook (`.git-hooks/pre-push`) runs lint/types/static checks locally — **not** unit or E2E tests, and **not** anything that needs local Supabase (Podman/Postgres). It does **not** deploy. Deploy is GitHub-managed after merge.

**Known CI flakes (re-run, don't "fix"):** `docker: toomanyrequests` at the Reset-database / Start-Supabase steps (Docker Hub anonymous pull limit — `gh run rerun <id> --failed`; GitHub rotates runner IPs so re-runs usually land clean), `db:doctor` auth 502 / "auth container not inspectable; recreating stack" (GoTrue slow start), and `tests/e2e/registration-approval.e2e.spec.ts` (Mailpit/GoTrue email-redirect timing). A real fix for the pull limit would be a `DOCKERHUB_TOKEN` login step in `ci.yml` (needs human-owned Docker Hub creds).

**Integration model.** Branch → PR → CI-gated auto-merge is **canonical** (see Ship section). Strict required checks (`CI / ci`, branch-up-to-date) serialize concurrent PRs so two separately-green PRs can't break `main` (see [docs/github-ci.md](docs/github-ci.md) → "Concurrent merges"). `/ship`'s direct push to `main` is **break-glass only** — it bypasses the required `ci` check via admin. After merge, babysit GitHub CI/deploy plus the Vercel deployment and fix failures with a forward-fix change.

## AWS IAM

- `agent-deploy` — scoped deploy role (S3, CloudFront, ECR, `lambda:UpdateFunctionCode`, `cloudformation:DescribeStackResource`, plus `lambda:InvokeFunction` on `*-live-provider-check` only — for the post-deploy live check). Used locally via the `fleet-deploy` profile for code-only deploys. Defined fleet-wide in `shared-infra/aws/template.yaml`.
- `github-actions-deploy` — scoped GitHub OIDC role for production code deploys from `birthmilk/stocktextalerts` on `main`. It reuses the code-only deploy policy and has no CloudFormation/SAM infra mutation permissions.
- `stocktextalerts-crons-*` — SAM-managed Lambda execution roles (auto-created; SES send via execution role, not static keys)

## Tooling Setup

See `docs/tooling-setup.md` for Production Supabase access (psql, env vars, project ref), Vercel CLI scope, and Mailpit dev email routing.

## Deploy gotchas

- **Merge to main before SAM deploy that changes env vars** — a deploy from an unmerged branch ships env-var drift that the next deploy from `main` silently reverts.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/display.ts`.

## Astro 7 notes

- **Rust compiler** and default **`compressHTML: "jsx"`** can change rendered whitespace or fail on invalid HTML — run `npm run build` after `.astro` edits.
- **Route caching:** Vercel CDN via `cacheVercel()` in `astro.config.ts`; logo proxy uses `context.cache.set()`.
- **Env typing:** rate-limit knobs are in `env.schema` (`astro:env/server`); other secrets still use `requireEnv()` from `src/lib/db/env.ts` (shared with Lambdas).
- **Advanced routing (`src/fetch.ts`):** not used; file-based routes + middleware remain the model.

## Security

- **CSRF / same-origin:** `security.checkOrigin: false` in `astro.config.ts`; proxy-aware enforcement lives in `src/middleware.ts` (webhook paths exempt). Set `ASTRO_SECURITY_CHECK_ORIGIN=true` to delegate back to Astro’s built-in check.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
