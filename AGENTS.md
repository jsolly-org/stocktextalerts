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

- Use `src/lib/logging/` (`createLogger`, `rootLogger`) — structured JSON with `timestamp`, `level`, `message`, `context`.
- Always pass a named context object (no `{}`/`undefined`).
- **Env vars**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use.

## Testing (Project-Specific)

- Tests share DB state — `fileParallelism: false`. Use `registerTestUserForCleanup` for test users.
- **Do not mock Supabase**: Use real client with seeded data via helpers in `tests/helpers/`.
- **Console spies**: Tests fail on unexpected `console.warn`/`console.error`. Use `expectConsoleWarning()`/`expectConsoleError()` from `tests/setup.ts`.
- **Schema version**: When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`.
- Pre-existing type error in `src/pages/api/auth/sms/send-verification.ts:201` (nullable param to RPC) — not ours, ignore.
- `formatPriceAlertSms` is **async** (shortens Grok link URLs via the `short_urls` table). Mock supabase for it must include a `.from().select().eq().gt().limit().single()` chain for the shortener dedup lookup. All other SMS formatters are sync.
- **Live API tests**: `npm run test:live:email`, `test:live:data`, `test:live:xai`, `test:live:all`. Always reproduce live test failures locally before fixing.

### Testing Philosophy: No real SES or Twilio, ever

After the 2026-04-11 incident where a local `--live=email` run delivered a real notification to a real mailbox via prod SES credentials from `.env.local`, the harness enforces a zero-real-delivery rule:

- **Tests never hit real AWS SES or real Twilio.** No exceptions, no opt-in flag that enables real credentials. Real credentials are reachable only from a production build (Lambda / Vercel SSR).
- **The three sender factories** hard-gate on `import.meta.env.MODE === "production"`:
  - `createEmailSender` — `src/lib/messaging/email/utils.ts`
  - `createSmsSender` — `src/lib/messaging/sms/twilio-utils.ts`
  - `sendVerification` / `checkVerification` (Twilio Verify) — `src/lib/auth/sms-verification.ts`
- **Live email tests** route through local **Mailpit** (Supabase's bundled Inbucket container) via SMTP on `localhost:1025`. `tests/run-vitest.ts` auto-sets `EMAIL_SMTP_HOST=localhost` when `--live=email` is passed, which makes `createEmailSender` pick the `nodemailer` branch instead of constructing a real SES client. Inspect delivered messages at http://localhost:54324.
- **Live SMS has no tier.** `--live=sms` was removed — the harness had no way to prevent real-number delivery or per-message Twilio charges. SMS code paths are covered by unit/integration tests that assert against the mock sender's recorded request shape.
- **Twilio Verify** always mocks in non-prod. The mock accepts `000000` as the only approved OTP, so local signup OTP flows can exercise both success and failure paths without hitting Twilio.
- **Test recipients are always `@example.com`.** Never reference real mailboxes or phone numbers in tests. `tests/helpers/test-user.ts:createTestEmail` generates `<prefix>-<runId>-<uuid>@example.com`.
- **`astro dev`** routes email through Mailpit automatically when `EMAIL_SMTP_HOST=localhost` is set in `.env.local` (the new committed default). Never set real SES env vars in dev.
- **Assertions**: use `tests/helpers/mailpit.ts` (`waitForMailpitMessage`, `waitForMailpitMessageTo`, `clearMailpit`) to inspect Mailpit content. For prod-safety unit assertions on the gates themselves, see `tests/lib/messaging/sender-gates.test.ts`.

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
- **Custom workflow or job**: `scripts/ci/run-local-actions.sh --workflow .github/workflows/<file>.yml --job <name>`.

**Limitations:**

- `Deploy Website` (`.github/workflows/deploy.yml`) has `if: github.actor != 'nektos/act'` and **skips under act**. To reproduce the E2E step from Deploy Website, run `npm run test:e2e` locally with the **CI-matching env vars** baked into `.env.local` (see `.github/actions/run-ci/action.yml` for the canonical list: dummy TWILIO creds, dummy AWS creds, `EMAIL_FROM=ci@example.com`, and the live Supabase local DB vars from `supabase status -o json`). Back up `.env.local` first.
- Act needs `DOCKER_HOST` pointing at Podman's socket. The `~/.zshrc` block that runs `podman machine inspect` to resolve the socket path should already be exporting it; check with `echo "$DOCKER_HOST"` before running act.
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

**SAM CLI (`sam local invoke`)** also honors `DOCKER_HOST`, so `cd aws && npm run local:test-all` works under Podman with the same setup.

## SES Migration History

Resend→SES email migration (PR #414) merged 2026-03-31. Notifications were down Mar 29–31 due to premature SAM deploy from feature branch that removed RESEND_API_KEY before merge. Lesson: always merge to main before SAM deploy that changes env vars.

## UI Conventions

- **All times shown to the user must respect `use_24_hour_time`** — pass `hour12: !is24` to `toLocaleTimeString` / `Intl.DateTimeFormat`. Stored on `users.use_24_hour_time` in DB, exposed as `user.value.use_24_hour_time` in Vue composables. Helper: `formatMinutesAsLocalTime(minutes, is24)` in `src/lib/time/format.ts`.

## Security

- Astro v5 CSRF protection on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).
