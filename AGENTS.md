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
npm run db:start           # Start local Supabase (Docker/Podman)
npm run db:reset           # Reset DB: regenerate seed, apply migrations, regen types
npm run db:bootstrap       # Canonical first-run / "reset everything": db:start + db:reset + db:doctor
npm run db:doctor          # Preflight: auth reachable + seed user login probe (~300ms)
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

- Use `src/lib/logging/` (`createLogger`, `rootLogger`) — structured JSON with `timestamp`, `level`, `message`, `context`.
- Always pass a named context object (no `{}`/`undefined`).
- **Env vars**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.
- **Lambdas also use the same logger** — `src/handlers/*.ts` import `createLogger` from `src/lib/logging`. Each Lambda log group has an `AWS::Logs::MetricFilter` on `{ $.level = "error" }` feeding the shared `stocktextalerts-crons/ErrorLogCount` metric and `ErrorLogAlarm`, alongside per-function `AWS/Lambda Errors` alarms. This matches the cross-repo pattern in `~/.agents/AGENTS.md` → "Lambda Logging". Do not set `LogFormat: JSON` on the Node Lambdas — the app logger already emits JSON via `console.*`.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Do not mock Supabase**: Use real client with seeded data via helpers in `tests/helpers/`.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- Pre-existing type error in `src/pages/api/auth/sms/send-verification.ts:201` (nullable param to RPC) — not ours, ignore.
- `formatPriceAlertSms` is **async** (shortens Grok link URLs via the `short_urls` table). Mock supabase for it must include a `.from().select().eq().gt().limit().single()` chain for the shortener dedup lookup. All other SMS formatters are sync.
- **Live API tests**: `npm run test:live:email`, `test:live:data`, `test:live:xai`, `test:live:all`. Always reproduce live test failures locally before fixing.

### Testing Philosophy: No real delivery from tests, ever

After the 2026-04-11 incident where a local `--live=email` run delivered a real notification to a real mailbox via prod SES credentials from `.env.local`, the harness enforces a zero-real-delivery rule:

- **Tests never hit real AWS SES or real Twilio credentials.** Real credentials are reachable only from a production build (Lambda / Vercel SSR).
- **The three sender factories** hard-gate via `isProduction()` from `src/lib/runtime/mode.ts` (reads `process.env.NODE_ENV`):
  - `createEmailSender` — `src/lib/messaging/email/utils.ts`
  - `createSmsSender` — `src/lib/messaging/sms/twilio-utils.ts`
  - `sendVerification` / `checkVerification` (Twilio Verify) — `src/lib/auth/sms-verification.ts`
- **Live email tests** route through local **Mailpit** (Supabase's bundled Inbucket container) via SMTP on `localhost:1025`. `tests/run-vitest.ts` auto-sets `EMAIL_SMTP_HOST=localhost` when `--live=email` is passed, which makes `createEmailSender` pick the `nodemailer` branch instead of constructing a real SES client. Inspect delivered messages at http://localhost:54324.
- **Live Twilio tests use Twilio test credentials only** (`test:live:twilio` / `--live=twilio`). They call Twilio's API with magic numbers (`+15005550006`, `+15005550009`) and do not deliver real SMS or incur charges.
- **App SMS sender remains production-gated.** `createSmsSender` still mocks outside production mode; live Twilio API tests run in a dedicated test file and do not route through app delivery flows.
- **Twilio Verify** always mocks in non-prod. The mock accepts `000000` as the only approved OTP, so local signup OTP flows can exercise both success and failure paths without hitting Twilio.
- **Test recipients are always `@example.com`.** Never reference real mailboxes or phone numbers in tests. `tests/helpers/test-user.ts:createTestEmail` generates `<prefix>-<runId>-<uuid>@example.com`.
- **`astro dev`** routes email through Mailpit automatically when `EMAIL_SMTP_HOST=localhost` is set in `.env.local` (the new committed default). Never set real SES env vars in dev.
- **Assertions**: use `tests/helpers/mailpit.ts` (`waitForMailpitMessage`, `waitForMailpitMessageTo`, `clearMailpit`) to inspect Mailpit content. For prod-safety unit assertions on the gates themselves, see `tests/lib/messaging/sender-gates.test.ts`.

## Supabase Migrations

- **Local files are source of truth.** Create with `supabase migration new <name>`, write SQL, commit, merge. CI runs `supabase db push`.
- **Never apply migrations directly to production** (no MCP against prod, no `db push` locally, no dashboard DDL).
- After creating/modifying a migration: `npm run db:gen-types`.
- Do NOT modify `src/lib/db/generated/database.types.ts` directly.

### Local bootstrap + seed hardening

- **Canonical bootstrap is `npm run db:bootstrap`** (runs `db:start`, `db:reset`, then `db:doctor`). Reach for this — not ad-hoc psql — whenever the local stack looks wedged (ECONNREFUSED from `@supabase/auth-js`, `invalid_credentials` on known-good password, empty `auth.users`, etc.). The 2026-04-18 "assets seeded but users didn't" incident was `supabase start` silently skipping half the seed; `db:reset` re-runs seed.sql through a fresh session and is reliable.
- **`npm test` auto-runs `db:doctor` via `pretest`**; `npm run dev` runs it via `predev` (non-blocking — a failure prints a hint and still starts the dev server so frontend-only work isn't gated on Supabase being up). CI calls `npm run test:ci`, which does **not** trigger `pretest` (npm lifecycle hooks are per-script name), so CI is unaffected.
- **`seed.sql` is hardened** by `scripts/db/generate-seed.ts`:
  - Section order: **users (auth + profile) → assets → user tracked assets → verification**. Users come first so a partial seed surfaces as "login broken" (obvious) rather than "user silently missing while assets succeed" (the original regression).
  - Each per-user block is wrapped in `BEGIN`/`COMMIT` for per-user atomicity.
  - The final `DO $$ … $$` block `RAISE EXCEPTION`s if any expected `auth.users` / `public.users` row, or any user's tracked assets, didn't land. This fails `supabase db reset` loudly instead of leaving a half-seeded stack.
  - Do **not** add psql meta-commands (`\set`, `\if`, etc.) to the generated SQL — `supabase db reset` streams it over a raw Postgres connection, not through psql, and those are syntax errors.
- **After machine reinstalls, Podman upgrades, or Supabase CLI upgrades**, run `scripts/ci/verify-local-supabase.sh` once to confirm the full bootstrap still works end-to-end (wraps `db:bootstrap` + `db:doctor`).

## Supabase Auth OTP

- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`.

## AWS / SAM Deploy

**SAM deploy required** when committing changes to `aws/template.yaml`, `aws/deploy.sh`, `src/handlers/`, or `src/lib/`. After the commit: `cd aws && npm run deploy` (or `npm run deploy:aws` from repo root). Use `--profile prod-admin` for all production AWS commands.

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

- **Prod dev-login account**: `test@jsolly.com` with `DEFAULT_PASSWORD` env var. This is the only place a real inbox is allowed to appear by name, and it exists as a row in production Supabase for interactive login during local dev against prod. It is **not** used by the test harness — `tests/helpers/constants.ts:PRESERVED_TEST_EMAIL` is `preserved-test@example.com`, deliberately non-routable.
- **Mailpit for dev email**: `.env.local` sets `EMAIL_SMTP_HOST=localhost` and `EMAIL_SMTP_PORT=1025` so any email the dev server would otherwise send through SES lands in Mailpit at http://localhost:54324 instead. Requires local Supabase running (`npm run db:start`). `tests/run-vitest.ts` strips both env vars under plain `npm test` so unit tests stay on the in-process mock sender, and re-exports them when `--live=email` is passed.

### Reproduce CI locally with Act

**Use Act before pushing changes that affect CI, workflows, tests, or dev tooling.** On 2026-04-11 a one-line race in `delivery-times.e2e.spec.ts` passed 20/20 locally but failed twice in CI — caught only because we reproduced the E2E step locally with CI-matching env. Don't skip this step; it's the cheapest way to catch CI-only regressions before they land on `main`.

- **Install**: `brew install act` (already installed; config in `.actrc`).
- **List jobs**: `act -l`.
- **Run the full test-and-build job locally** (composite action: migrations, npm test, test:smoke, build):
  ```bash
  npm run gha:local:test-build
  ```
  Uses `scripts/ci/run-local-actions.sh` → runs `noDeploy.yml`'s `test-and-build` job in a `catthehacker/ubuntu` container with the repo mounted. Matches CI's node version, Supabase CLI version, and exact step sequence.
- **Run only the lint job**: `npm run gha:local:lint`.
- **Run the full E2E suite (workflow_dispatch-gated job)**: `npm run gha:local:e2e`. Reproduces the deploy workflow's E2E step against `run-ci` without prod credentials. Skipped on normal pushes to `main` to keep CI fast; opt in via `workflow_dispatch` or this script.
- **Custom workflow or job**: `scripts/ci/run-local-actions.sh --workflow .github/workflows/<file>.yml --job <name>`.

**Limitations:**

- `Deploy Website` (`.github/workflows/deploy.yml`) is **not act-runnable by design**. It links the live Supabase project, pushes migrations, deploys to Vercel, and updates Lambda code with real credentials. `scripts/ci/run-local-actions.sh` explicitly rejects `--workflow .github/workflows/deploy.yml` to prevent half-run production side effects. To reproduce its CI parts locally, use `npm run gha:local:test-build` (same `run-ci` composite) and `npm run gha:local:e2e` (same Playwright step).
- Act needs `DOCKER_HOST` pointing at Podman's socket. The `~/.zshrc` block that runs `podman machine inspect` to resolve the socket path should already be exporting it; check with `echo "$DOCKER_HOST"` before running act.
- **Podman VM needs ≥ 6144 MB of memory** for Vitest to complete without the in-VM OOM killer issuing `SIGKILL` (the exact failure chased on 2026-04-19 — Vitest died with no test-level error). `scripts/ci/run-local-actions.sh` preflight-checks the `podman-machine-default` VM and fails with the fix command if it's undersized. It also prunes stale `act-*` containers from prior runs that would otherwise keep the VM under memory pressure.
- Act containers run the host's native architecture (arm64 on Apple Silicon, amd64 on Linux/Intel CI runners). Forcing `linux/amd64` via `--container-architecture` made Playwright's headless Chromium crash under QEMU on M-series Macs (`qemu: uncaught target signal 5`), so it's intentionally omitted from `.actrc`. CI still runs amd64 natively on GitHub's Ubuntu runners, and `catthehacker/ubuntu:act-latest` ships both arches — local runs now ~2× faster than the amd64-forced setup.

**When to run it (checklist before `git push`):**

1. Any change to `.github/workflows/**` or `.github/actions/**`.
2. Any change to `tests/**` that isn't purely additive (moving/renaming tests, changing setup/teardown, test helpers, vitest config, playwright config).
3. Any change to `tests/run-vitest.ts`, `playwright.config.ts`, `tests/setup.ts`, `tests/helpers/live-api.ts`, or anything else that gates test behavior on env vars.
4. Any change to `supabase/config.toml` (service toggles, migration loader, SMTP settings).
5. Any change to `package.json` scripts that CI calls (`test`, `test:ci`, `test:smoke`, `test:e2e`, `build`).
6. Any change to core build tooling: `astro.config.mjs`, `vitest.config.ts`, `tsconfig*.json`.
7. Any change that adds/removes a `@*/`-scoped dependency or shifts dev deps to runtime deps (or vice versa).

For pure `src/lib/**` or `src/pages/**` changes that don't touch any of the above, local `npm test`/`npm run test:e2e` are sufficient — act adds latency for no signal.

### Local container runtime: Podman

Local Supabase runs in containers. This project is on **Podman** (not Docker Desktop). Docker Desktop was uninstalled on 2026-04-11 after it ate ~40G of disk.

**One-time shell setup** — add to `~/.zshrc`:

```zsh
export PATH="/opt/podman/bin:$PATH"
export DOCKER_HOST="unix://$(/opt/podman/bin/podman machine inspect podman-machine-default --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null)"
```

(The `DOCKER_HOST` value resolves at shell-startup time to the current Podman machine's socket — it's `/var/folders/.../T/podman/podman-machine-default-api.sock` and changes if the machine is recreated.)

**Gotchas we've hit:**

- **Vector / Logflare analytics is disabled** in `supabase/config.toml` (`[analytics] enabled = false`). Supabase's `vector` container tries to read Docker logs from `/var/run/docker.sock` inside its own container, which Podman's Docker-compat shim doesn't plumb the same way — `supabase start` hangs on *"vector container is not ready: starting"* otherwise. We don't use the local analytics UI so this is a net win, not a workaround.
- **`supabase stop` may emit** `failed to prune volumes: "all" is an invalid volume filter`. It's a warning from Podman's Docker-compat shim not recognizing Docker's `all=true` volume filter; safe to ignore.
- **`podman` on PATH**: the `/opt/podman/bin` install location isn't in the default shell PATH. Add the export above or the `supabase` CLI won't find the podman binary for its auxiliary commands.

**CI stays on Docker.** GitHub Actions Ubuntu runners ship with Docker preinstalled, and `.github/workflows/live-provider-tests.yml` already passes `supabase start -x studio,imgproxy,logflare,vector,postgres-meta,edge-runtime,realtime,storage-api`. Switching CI to Podman would add setup time for zero benefit.

**SAM CLI (`sam local invoke`)** also honors `DOCKER_HOST`, so `cd aws && npm run local:all` works under Podman with the same setup.

## SES Migration History

Resend→SES email migration (PR #414) merged 2026-03-31. Notifications were down Mar 29–31 due to premature SAM deploy from feature branch that removed RESEND_API_KEY before merge. Lesson: always merge to main before SAM deploy that changes env vars.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).

<!-- BEGIN GLOBAL RULES (managed by sync-global-agents.sh) -->
## Family Memory

When the family-memory MCP is available, call `recall` (no args) at conversation start to load context about the user. Use `remember` to store notable new facts, preferences, or events that come up naturally.

## Collaboration

- Use `--headed --persistent` when launching playwright-cli for interactive browser sessions. Without `--headed`, it defaults to headless.
- No pull requests for personal projects. `/review-fix-push` skill is the sole review gate — reviews local changes against remote, fixes issues, commits and pushes.
- Custom skills live at `~/.agents/skills/` (e.g., `~/.agents/skills/review-fix-push/SKILL.md`), not `.claude/plugins/`.
- `~/.cursor/skills/` and `~/.claude/skills/` must be **real directories** (not symlinks to `~/.agents/skills/`). The `npx skills add` installer stores content in `~/.agents/skills/<name>/` then creates per-skill symlinks from each agent dir — directory-level symlinks cause circular links.
- Family/domain knowledge lives in the family-memory MCP, not in flat files.
- Don't create new IAM users or roles when an existing one can be reused — these are personal projects, avoid role sprawl.
- Always run `sam deploy` after modifying `aws/template.yaml` — there's no CI for SAM stacks, only code-only updates deploy via GitHub Actions.

## AWS

- Use `--profile prod-admin` for all production AWS commands.
- SSO profiles: `prod-admin` (730335616323, production), `general-admin` (541310242108), `amplify-admin`, `jsolly-sandbox`, `jsolly-dev`.

## Error Logging & alert-hub

**Goal.** Every uncaught exception or `level=error` log entry from any personal-project Lambda lands in a single email inbox with the actual error text — no need to open CloudWatch.

### Pipeline

```
Lambda (structured JSON logger)
  -> CloudWatch Logs (/aws/lambda/<FunctionName>)
  -> CloudWatch Alarm (AWS/Lambda Errors  AND  custom MetricFilter on level=error)
  -> SNS topic (alert-hub-notifications, ARN at SSM /alert-hub/alert-topic-arn)
  -> alert-hub Enricher Lambda (~/code/alert-hub/aws/enricher/handler.py)
  -> Logs Insights pulls the matching log group's recent error lines
  -> SES email with alarm header + extracted error summary + raw alarm JSON
```

The enricher is best-effort: a Logs Insights timeout or missing log group falls through to a plain passthrough email so an alarm is **never** silenced.

### Downstream Lambda contract

Every Lambda that publishes alarms to alert-hub must:

1. **Use the structured logger.** Never `console.log`/`console.error` in app code.
   - Node source of truth: `~/code/family-memory/src/shared/logging.ts` (port verbatim into other Node repos and keep them in sync). PII masking (phones/emails/tokens), sensitive-key redaction, stable JSON shape.
   - Python: rely on the runtime's `LogFormat: JSON` and `logger.error()` / `logger.exception()`. Logger emits uppercase `"ERROR"` level.
2. **Explicit `AWS::Logs::LogGroup`** named `/aws/lambda/<FunctionName>` with `RetentionInDays: 30`. Wire on the function via `LoggingConfig.LogGroup: !Ref <LogGroup>`.
3. **Explicit `FunctionName`** on each `AWS::Serverless::Function` so the log group name is deterministic instead of `<stack>-<logical>-<hash>`. Hyphenated, repo-prefixed (`misc-notifications-morning-text`, `family-memory-memories`).
4. **Do not set `LogFormat: JSON` on Node Lambdas** — the app-level logger already emits structured JSON; the runtime wrapper would double-wrap. Python Lambdas DO set `LogFormat: JSON` (no app-level logger).
5. **Two alarms per Lambda, both wired to alert-hub** with `AlarmActions` AND `OKActions`:
   - **(a) `AWS::CloudWatch::Alarm` on `AWS/Lambda Errors`** (FunctionName dimension). Catches crashes, timeouts, OOM. Always discoverable by the enricher.
   - **(b) `AWS::Logs::MetricFilter` on `{ $.level = "error" }`** (Node) or `{ $.level = "ERROR" }` (Python) plus a custom-namespace alarm. Catches application-logged errors that didn't crash the invocation (e.g. swallowed per-recipient failure inside a `Promise.allSettled`).
6. **Custom metric namespace must align with the Lambda function-name prefix** so the enricher's prefix discovery (`describe_log_groups(prefix=/aws/lambda/<namespace>)`) finds the right log groups. Example: namespace `family-memory` → matches log groups `/aws/lambda/family-memory-*`. Drift here breaks enrichment for the metric-filter alarm.
7. **Logging contract test** (Node only — Python uses the runtime): `tests/logging-contract.test.ts` pins JSON shape, level values, and PII masking so the enricher's `extract_error_summary` keeps working.

Copy-paste starter that satisfies the contract: `~/code/alert-hub/templates/lambda-logging.yaml`.

### Logger usage

```ts
// Node — instantiate once per module with shared base context.
const logger = createLogger({ job: "morning-text" });

logger.info("Send claimed", { recipient: to, dateLocalIso });
logger.warn("Failed to fetch iCloud calendar", { subsystem: "caldav" }, error);
logger.error("Recipient send failed", { recipient: to }, error);
```

```py
# Python — Lambda runtime renders this as JSON via LogFormat: JSON.
logger.error("Failed to process record", extra={"recipient": to})
logger.exception("Unexpected failure")  # includes traceback
```

`error` argument is serialized via `serializeError` (Node) — `error.name`, `error.message`, `error.cause`, full stack — which is what the alert-hub enricher's `extract_error_summary` reads to render the email's "Error log lines" block.

### Logging levels (cross-repo)

- `info` — expected business rejections (auth failures, invalid input, rate limits) and routine lifecycle events.
- `warn` — early signals that could escalate to an error if ignored, or transient failures that the next retry / next scheduled invocation may recover from on its own.
- `error` — the failure can't be fixed by a retry, or retries have already exhausted. The data is wrong, the operation can't complete, the parser rejected input we expected to parse.

**Per-recipient / per-item error handling inside a fan-out:** wrap with `Promise.allSettled` (or equivalent), then **log each rejected reason at `error`** before re-throwing the aggregate. Lambda's runtime serializes only the top-level error message — without an explicit log-per-failure, the actual cause never reaches the enricher.

### alert-hub side

- **Enricher source:** `~/code/alert-hub/aws/enricher/handler.py`. Logs Insights query is `level = "error" or level = "ERROR"`, sorted desc, limit 20. Extraction parses Node tab-delimited JSON tail and Python-runtime JSON objects, surfacing `error.name + error.message` (or `stackTrace[:5]`).
- **Discovery:** AWS/Lambda alarms → `/aws/lambda/<FunctionName>` (deterministic). Custom namespace alarms → `describe_log_groups(prefix=/aws/lambda/<namespace>)`. `AWS/Scheduler|AWS/SQS|AWS/Events` alarms skip enrichment by design (no per-namespace log group).
- **Self-recursion guard:** any `AlarmName` containing `alert-hub` is passthrough-only, even on `OK` recovery. Prevents the enricher's own metric filter from looping.
- **IAM:** enricher has `logs:StartQuery`, `logs:GetQueryResults`, `logs:DescribeLogGroups` on `*` because it serves arbitrary downstream stacks.

### Adding a new project

1. Resolve the topic ARN in the SAM template:
   ```yaml
   AlertTopicArn:
     Type: AWS::SSM::Parameter::Value<String>
     Default: /alert-hub/alert-topic-arn
   ```
2. Copy the relevant blocks from `~/code/alert-hub/templates/lambda-logging.yaml` (LogGroup + MetricFilter + both alarms).
3. Pick a custom MetricNamespace that matches your Lambda function-name prefix.
4. If publishing alerts directly from app code (not just via alarms), grant `sns:Publish` on `!Ref AlertTopicArn` to the function role.
5. Use the structured logger and emit `level=error` for non-recoverable failures.

## User Context

Software engineer turned Sr. Director at Leidos (Health-IT under DIGMOD). I use this chat to think through ideas, explore topics, write code, and have real conversations.

When exploring ideas, be discursive and collaborative — follow the thread wherever it goes, even if it gets uncomfortable. Steel-man arguments, don't lecture. When I'm vague, call it out directly. When my logic doesn't hold up, say so. I'd rather be challenged than reassured. I value extreme bluntness, the proactive surfacing of things I haven't considered, and getting closer to the truth over reaching a comfortable answer.

## Conversation Preferences

- **Ask when ambiguous.** If there's one obvious approach, just do it. If there are meaningful tradeoffs or multiple paths, stop and ask.
- **Layered questions.** Ask the 2-3 most critical questions first, start on what's clear, then follow up as you go.
- **Present options with a recommendation.** "Here are approaches X, Y, Z. I'd recommend Y because..." — then wait.
- **Brief rationale.** A sentence or two on the "why" is enough. Don't belabor it.
- **Casual and direct.** Like a coworker on Slack. No hedging, no filler.
- **Do what I asked, but flag concerns.** If you think the approach has issues, implement it and note the concern — don't silently diverge.
- **Update at the end.** Show the result when done. Only interrupt mid-task if blocked.
- **Proactively improve adjacent code.** If you see something nearby that could be better, clean it up. Prefer deep refactoring over preserving backwards compatibility.
- **Concise responses.** Short, dense with information. I can ask for more detail.
- **When uncertain, ask.** Don't guess at project conventions, intent, or technical details — even if it slows things down.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`

Common types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`, `perf`. Scope is the area of the codebase (e.g., `auth`, `notifications`, `e2e`, `deps`).

## Code Style

- **No compatibility layers**: No shims, adapters, deprecations, or re-exports for legacy behavior.
- **No browser polyfills**: Modern browser APIs (`fetch`, `URL`, `AbortController`, `crypto.randomUUID()`, etc.) are assumed. Server-side polyfills are fine when Node.js lacks the API.
- **Relative paths only**: No `@`-style aliases.
- **No barrel files / re-exports**: Import from the defining module, not intermediary files.
- **No timing hacks**: No `setTimeout`/`nextTick`/`requestAnimationFrame` to mask race conditions. Fix the root cause. Legitimate uses (debouncing, throttling) are fine.

## Error Handling

- **Trust the type system**: Skip defensive null/undefined checks when strict TypeScript or DB constraints guarantee safety. Add checks only when values can legitimately be missing (parsed JSON, nullable columns, third-party payloads).
- **Deterministic error checking**: Use structured error properties (`error.code`, `error.status`), not string matching (`.includes()`) on messages.
- **Fail fast**: No silent fallbacks or default values on unexpected errors. If a fallback is needed for resilience, gate it on structured error properties and log with context.
- **Logging levels**:
  - `info` — expected business rejections (auth failures, invalid input, rate limits) and routine lifecycle events.
  - `warn` — early signals that could escalate to an error if ignored, or transient failures that the next retry / next scheduled invocation may recover from on its own.
  - `error` — the failure can't be fixed by a retry, or retries have already exhausted. The data is wrong, the operation can't complete, the parser rejected input we expected to parse.

## Testing Philosophy

- **Scenario-based coverage**: Cover real-world scenarios that could happen in production — not to maximize code coverage or add a test file per source file. Each test should represent a plausible user journey or system event.
- **Integration over isolation**: Prefer integration tests that use real dependencies. Only mock external services that consume paid API allocations.
- **Assert via behavior, not mocks**: Prefer asserting on DB state, response payloads, and status codes rather than on mocked return values or call counts.
- **Realistic data**: Use real names, realistic values, and plausible details. Never use placeholder values like `foo`, `bar`, `test123`, or round numbers when a realistic value would work.
- **Scenario-based test style**: Frame `describe`/`it` blocks around user journeys or system events, not abstract technical operations.
  - Good: `"User in Pacific timezone receives market update after close"`
  - Bad: `"returns correct value when input is 2"`
<!-- END GLOBAL RULES (managed by sync-global-agents.sh) -->
