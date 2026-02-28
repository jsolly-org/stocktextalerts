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

**Stack:** Astro 5 (SSR) on Vercel, Vue 3 interactive components, Tailwind CSS 4, Supabase (PostgreSQL + Auth), Twilio (SMS), Resend (email), Massive (prices), Finnhub (symbols/earnings), xAI/Grok (optional AI summaries).

### Notification Pipeline (three-phase)

1. **Pre-compute** — Cron jobs render HTML/SMS content into `staged_notifications` table with `scheduled_for` timestamps
   - `/api/asset-events` (daily 00:00 UTC) — earnings, dividends, splits, IPOs
   - `/api/daily-digest` — news/rumors digest
2. **Delivery** — `/api/schedule` (every minute) fetches due `staged_notifications` rows and sends via email/SMS
3. **Real-time alerts** — `/api/schedule` also runs price alert detection during market hours via Massive snapshots

All cron endpoints require `Authorization: Bearer <CRON_SECRET>`.

### Key Directories

- `src/pages/api/` — API endpoints (auth, assets, schedule, notifications)
- `src/lib/` — Server logic: `db/`, `auth/`, `providers/`, `market-notifications/`, `daily-digest/`, `asset-events/`, `messaging/`, `schedule/`, `time/`, `logging/`
- `src/components/dashboard/` — Vue dashboard panels with composables
- `supabase/migrations/` — SQL migrations (source of truth; CI pushes to production)
- `tests/helpers/` — `test-user.ts`, `test-env.ts`, `asset-data.ts`

### Database

Supabase with RLS on all tables. Core tables: `users`, `assets`, `user_assets`, `staged_notifications`, `notification_log`, `asset_events`, `market_snapshots`. Service role key for privileged server ops only.

### Middleware (`src/middleware.ts`)

Validates required env vars (once), assigns per-request ID, applies security headers (CSP, HSTS, X-Frame-Options), enforces CSRF origin checks for mutation requests.

## Supabase Migrations
- **Always** create migrations with `supabase migration new <name>` — never create files manually or rename timestamps.
- The CLI generates a precise timestamp (e.g., `20260209223746`). This timestamp is recorded in the remote `schema_migrations` table when `supabase db push` runs in CI. Renaming the file (e.g., to `20260209200000`) causes a mismatch that breaks CI.
- **Production is CI-only.** Do not run `supabase db push` against production from a local machine. Do not run `supabase link --project-ref` with the production project ref. Do not use MCP `apply_migration` against the production database. Do not execute DDL via the Supabase dashboard SQL editor.
- **Production migration path:** `supabase migration new <name>` → write SQL → commit → merge to `main` → CI runs `supabase db push`.
- MCP `apply_migration` is for iterating on the **local** Supabase database only.

## Local Dev Login
- Test user email: `test@jsolly.com` (defined in `scripts/data/users.json`)
- Password: the `DEFAULT_PASSWORD` value from `.env.local`
- Created by `supabase/seed.sql` (regenerated via `npm run db:gen-seed`)

## GH_AGENT_TOKEN (CI Secret)
Many workflows use `GH_AGENT_TOKEN` because GitHub's `GITHUB_TOKEN` lacks the `workflows` permission. Without it, auto-merge, branch updates, and agent pushes that touch `.github/workflows/` will fail.

**Where to add:** Repository Settings → Secrets and variables → Actions → New repository secret → name: `GH_AGENT_TOKEN`.

**How to create:** Use a [Personal Access Token (classic)](https://github.com/settings/tokens) or [fine-grained token](https://github.com/settings/personal-access-tokens/new).

**Required permissions:**

| Token type   | Permissions |
|--------------|-------------|
| Classic PAT  | `repo` and `workflow` |
| Fine-grained | `Contents: Read and write`, `Pull requests: Read and write`, `Workflows: Read and write`, `Issues: Read and write` |

Fine-grained: restrict to "Only select repositories" → this repo. Classic: no additional scopes beyond `repo` and `workflow`.

**Token lifecycle:**
- Set an expiration period appropriate for your security policy (recommended: 90 days).
- When the token expires, workflows will fail with authentication errors. Create a new token and update the repository secret.
- Consider setting a calendar reminder for token renewal.

## `vars.AGENT_MODEL`

All 8 nightly agent workflows read the model name from the GitHub repository variable `AGENT_MODEL` (e.g. `claude-sonnet-4-20250514`). This lets you change which model every workflow uses from a single place.

**Where to set:** Repository Settings → Secrets and variables → Actions → Variables tab → `AGENT_MODEL`.

## `vars.PRODUCTION_SITE_URL` (Deploy)

The deploy workflow builds the site with this URL so the prebuilt output (prerendered pages, sitemap, canonicals, OG images, JSON-LD) uses the production domain instead of localhost. Required for correct production deploys when using `vercel deploy --prebuilt` and `ignoreCommand` to skip Vercel's Git build.

**Where to set:** Repository Settings → Secrets and variables → Actions → Variables tab → `PRODUCTION_SITE_URL` (e.g. `https://stocktextalerts.com`).

## Key Constraints

- **Biome** for all formatting/linting. `noConsole` is an error — use `src/lib/logging/` instead.
- **Astro files excluded from Biome** due to `---` delimiter formatter bug.
- **Tests share DB state** — `fileParallelism: false` in vitest config. Use `registerTestUserForCleanup` for test users.
- **Node 24.x** (see `.nvmrc`), **npm** (not yarn/pnpm).

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
- [CI Security](.agents/ci-security.md)

## Cursor Cloud-specific instructions

### System dependencies
- **Node.js 24** — required (`.nvmrc`). Use `source ~/.nvm/nvm.sh && nvm use 24` before any npm command.
- **Docker** — required for local Supabase. Start the daemon with `sudo dockerd &>/tmp/dockerd.log &`.
  Avoid `chmod 666 /var/run/docker.sock`; prefer either:
  - running Docker commands with `sudo`, or
  - adding your user to the `docker` group (`sudo usermod -aG docker "$USER"`), then re-login.
  Docker is configured with `fuse-overlayfs` storage driver and `iptables-legacy` for the nested container environment.

### Service startup sequence
1. Start Docker daemon (see above)
2. `npm run db:start` — starts ~15 Supabase containers (Postgres, Auth, PostgREST, Studio, Mailpit, etc.)
3. `npm run db:reset` — generates seed, applies migrations, seeds DB, regenerates TypeScript types
4. `npm run dev` — starts Astro dev server at `http://localhost:4321`

### Key local URLs

| Service | URL |
|---------|-----|
| Astro dev server | http://localhost:4321 |
| Supabase Studio | http://127.0.0.1:54323 |
| Mailpit (email) | http://127.0.0.1:54324 |

### Gotchas
- The `.env.local` file must exist before running tests or the dev server. Copy from `env.example` and fill in Supabase keys from `supabase status` output. For external APIs (Twilio, Massive, Finnhub), use fake/placeholder values — tests stub them.
- `scripts/data/users.json` is gitignored and must be created manually (copy from `scripts/data/sample-users.json` or create with a `test@jsolly.com` entry). Without it, `npm run db:gen-seed` still works but creates no test users.
- `supabase db reset` may emit a transient 502 during container restart — this is harmless. Run `npm run db:gen-types` separately if it fails mid-pipeline.
- `npm run check:ts` has a pre-existing TS error in `src/pages/api/auth/sms/send-verification.ts` (Type 'string | null' not assignable to type 'string'). This is in the existing codebase, not introduced by setup.
- Vitest tests require a running Supabase instance. Always `npm run db:start` + `npm run db:reset` before `npm test`.
- Playwright E2E tests need browsers installed first: `npx playwright install`.
