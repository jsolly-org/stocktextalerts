# 📈 StockTextAlerts.com

A securities notification app that sends scheduled email and Telegram updates (scheduled asset price notifications, daily digests, and asset events) and optional per-stock price-move alerts for tracked US stocks and ETFs. Built with Astro, deployed on Vercel, with Supabase authentication and a PostgreSQL database. Email is sent via AWS SES; Telegram messages via the Telegram Bot API. 🔔

## Features

- **Asset Tracking** - Search and track US stocks and ETFs (up to 10)
- **Email Notifications** - Receive updates via email (AWS SES)
- **Telegram Notifications** - Optional delivery via the Telegram bot (Telegram Bot API)
- **Price Move Alerts** - Optional per-stock alerts during US market hours: set a threshold per tracked stock as a percent or dollar move in a single trading day. Capped at one alert per symbol per US trading day
- **Timezone Support** - Browser-detected timezones with user overrides
- **Market Notifications** - Choose up to 8 delivery times for scheduled asset price updates (10:00 AM–3:59 PM ET on market-open days), and decide if they're delivered by email, Telegram, or both
- **Daily Digest** - Once-daily digest with asset prices by email and/or Telegram, plus optional News/Rumors add-ons (email-only and may include clickable source links)
- **Asset Events** - Daily notification of upcoming calendar events (earnings/dividends/splits) and IPOs, plus optional insider trades and analyst consensus (each event type can be toggled per channel and delivered by email and/or Telegram)
- **Format Preferences** - Customize how your updates look with live email/Telegram previews and optional sparklines (weekly price trend)

## Tech Stack

- **Framework**: Astro 7 with SSR (Vite 8 / Rolldown)
- **UI**: Vue 3 components with Tailwind CSS
- **Icons**: Local SVGs in `/src/icons` loaded via `astro-icon` in `.astro` files; Vue components import SVGs via `vite-svg-loader` using the `?component` suffix
- **Database**: Supabase (PostgreSQL)
- **Market Data**: Massive (prices/dividends/splits/IPOs) + Finnhub (symbols, earnings, market hours, analyst/insider extras)
- **AI Summaries**: xAI (Grok) for optional News/Rumors add-ons
- **Email**: AWS SES
- **Telegram**: Telegram Bot API
- **Hosting**: Vercel (dashboard) + AWS Lambda (notification crons via SAM)
- **Search**: Server-side search over Finnhub-sourced asset data (local DB)
- **Linting**: Biome (no ESLint or Prettier)
- **Testing**: Vitest + Playwright

## Design System

- **Tokens**: Semantic color tokens live in `src/global.css` via Tailwind v4 `@theme`.
- **Status UI**: Use `StatusMessage.astro` / `StatusMessage.vue` or the `status-tone-*` classes for alerts.
- **Neutrals**: Prefer semantic surface/text/border tokens (e.g. `bg-surface`, `text-heading`, `border-edge`, `text-muted`) and only reach for `gray-*` utilities when a token doesn't exist.

## Prerequisites

- Node.js (see `.nvmrc` for the required version)
- A container runtime: **Podman** (recommended) or Docker. Podman requires `DOCKER_HOST` to point at its socket; see `AGENTS.md#local-container-runtime-podman` for the one-time shell setup.
- Supabase account
- Massive account (API key)
- Finnhub account (API key)
- xAI account (optional, only needed for News/Rumors add-ons)
- Vercel account (for dashboard deployment)
- AWS account with SAM CLI (for notification Lambda crons)

## Development Setup

### 1. Clone and Install

```bash
git clone git@github.com:jsolly/stocktextalerts.git
cd stocktextalerts
npm install
```

### 2. Create Accounts

**Supabase:**

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Choose a project name, database password, and region
3. Wait for the project to finish provisioning

**Vercel:**

1. Push your code to GitHub (if you haven't already)
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Don't deploy yet - add environment variables first

### 3. Environment Variables

> **Note:** Where possible, use official [Supabase integrations](https://supabase.com/docs/guides/platform/marketplace) instead of manually managing API keys as environment variables. Integrations are configured in the Supabase Dashboard and inject credentials automatically — no env vars needed.

Create a `.env.local` file in the root directory (you can copy from `env.example` and fill in secrets). This file is gitignored and **must not** be committed.

```env
# Site Configuration
# VERCEL_URL is automatically set by Vercel for all deployments.
# For local development, set it manually:
VERCEL_URL=http://localhost:4321

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:password@host:5432/database

# Email unsubscribe token signing
UNSUBSCRIBE_TOKEN_SECRET=your-random-secret-string  # Minimum 12 characters; use `openssl rand -hex 32`

# Email (local dev / tests)
# Dev routes through Mailpit when EMAIL_SMTP_HOST is set (see docs/tooling-setup.md).
# Production notification email is sent by AWS Lambda (SES via execution role), not Vercel.
# Lambda reads the From header from SSM (/stocktextalerts/email-from); keep EMAIL_FROM aligned.
EMAIL_FROM="Your Project Name <notifications@updates.example.com>"
# Comma-separated email allowlist for the minimal pending-user approval page.
# Include test@jsolly.com locally if you use the seeded dev-login account.
ADMIN_EMAILS=test@jsolly.com
# Shared HMAC secret for Vercel -> AWS email dispatch. Generate with `openssl rand -hex 32`.
EMAIL_DISPATCH_SECRET=your-email-dispatch-secret
# Production Vercel only, after deploying AWS email dispatch Lambda Function URL.
# EMAIL_DISPATCH_URL=https://example.lambda-url.us-east-1.on.aws/
EMAIL_SMTP_HOST=localhost
EMAIL_SMTP_PORT=1025

# Massive (asset prices / dividends / splits / news)
MASSIVE_API_KEY=your-massive-api-key

# Finnhub (earnings / market hours / symbol search / analyst/insider extras)
FINNHUB_API_KEY=your-finnhub-api-key

# xAI (Grok) - optional, only needed for News/Rumors add-ons
XAI_API_KEY=your-xai-api-key

# Logging
LOG_MASK_PII=true

# Seed Data (Local Development)
DEFAULT_PASSWORD=your-strong-local-seed-password
```

**Where to find these:**

- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`: Supabase Dashboard → Project Settings → API Keys
- `SUPABASE_SECRET_KEY`: Supabase Dashboard → Project Settings → API Keys → Secret keys
- `DATABASE_URL`: Supabase Dashboard → Project Settings → Database → Connection String → Transaction mode (pooler)
- `UNSUBSCRIBE_TOKEN_SECRET`: Generate a random string (minimum 12 characters; e.g., `openssl rand -hex 32`)
- `EMAIL_FROM`: Verified SES sender; keep in sync with SSM `/stocktextalerts/email-from`. Lambda uses SSM at deploy time; Vercel does not need this for app-triggered emails.
- `ADMIN_EMAILS`: Comma-separated allowlist for `/admin/users` (pending-user approval UI). Include `test@jsolly.com` locally when using the seeded dev-login account.
- `EMAIL_DISPATCH_SECRET`: Shared HMAC secret used by Vercel to invoke the AWS email dispatch Lambda. Use the same value in SAM/Vercel; never commit the real value.
- `EMAIL_DISPATCH_URL`: Vercel production URL for the AWS email dispatch Lambda Function URL.
- `EMAIL_SMTP_HOST` / `EMAIL_SMTP_PORT`: Local Mailpit routing for dev and live email tests — not used in production Lambda
- Massive credentials: Massive Dashboard → API Keys
- Finnhub credentials: Finnhub Dashboard → API Keys
- xAI credentials: xAI Console → API Keys
- LOG masking: optional, defaults to true

**Security Note:** The `SUPABASE_SECRET_KEY` bypasses Row Level Security. Never expose it on the client side. The `.env.local` file (and all `.env*` files) are excluded from version control via `.gitignore`.

**Platform-only config (not part of `.env.local`):**

- **Vercel-managed/injected:** `VERCEL_URL` is set automatically on hosted deployments. If you use the Vercel Supabase integration, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` come from that integration instead of a committed/shared env file.
- **Vercel (SSR + webhooks):** `UNSUBSCRIBE_TOKEN_SECRET` (must match Lambda — signs email unsubscribe links), `MASSIVE_API_KEY` (asset logo proxy), `ADMIN_EMAILS`, `EMAIL_DISPATCH_URL`, and `EMAIL_DISPATCH_SECRET`. App-triggered emails are dispatched to AWS Lambda via HMAC; outbound notification email/Telegram is sent by **AWS Lambda**, not Vercel — do not add Lambda-only `FINNHUB_API_KEY`, `XAI_API_KEY`, `EMAIL_FROM`, or AWS access keys to Vercel.
- **AWS Lambda (SAM deploy from `.env.local` via `aws/sam-params.sh`):** Supabase prod keys, `UNSUBSCRIBE_TOKEN_SECRET`, Massive, Finnhub, optional `XAI_API_KEY`. `EmailFrom` is **not** passed on the CLI — the template defaults to SSM `/stocktextalerts/email-from`. SES auth is the Lambda execution role, not static `AWS_*` keys.
- **Local-only values:** `DATABASE_URL` and `DEFAULT_PASSWORD` are for local Supabase + seed generation and should not be added to Vercel.
- **GitHub production deploy creds:** `DATABASE_URL_PROD` lives in the GitHub `Production` environment; AWS uses the OIDC `github-actions-deploy` role. Vercel production web deploys are handled by the Vercel GitHub integration, not a GitHub Actions `VERCEL_TOKEN`. Local `.env.local` deploy creds remain only for break-glass `npm run deploy:code`.
- **Live provider keys** (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`): SAM parameters in gitignored `.env.local` (via `aws/sam-params.sh`), consumed by the runtime Lambdas and the scheduled `stocktextalerts-live-provider-check` Lambda (weekday mid-session live vendor health check). Failures fire `stocktextalerts-live-provider-check-lambda-errors` → **shared-infra** (SES email).

### 4. Generate Seed File

The `db:generate-seed` script tries to list existing Supabase Auth users (via `supabase.auth.admin.listUsers()`) so it can reuse IDs when regenerating `supabase/seed.sql`. If Supabase isn't running or Auth isn't ready yet, it will still generate a valid seed file with new UUIDs.

Start Supabase (recommended):

```bash
npm run db:start
```

Then generate the seed file (this uses your `DEFAULT_PASSWORD` from `.env.local`):

```bash
npm run db:generate-seed
```

This creates `supabase/seed.sql` with test user data.

**Important Notes:**

- `supabase/seed.sql` is auto-generated by `scripts/db/generate-seed.ts` and is gitignored
- The seed file includes test user passwords that are generated from `DEFAULT_PASSWORD`
- Always regenerate `seed.sql` after updating `scripts/data/users.json` or `scripts/data/us-assets.json`
- To add test users, copy `scripts/data/sample-users.json` to `scripts/data/users.json` (no passwords needed)

### 5. Start Local Development

Reset Supabase to apply migrations and load the seed (this also regenerates `supabase/seed.sql` and database types):

```bash
npm run db:reset
```

Start the Astro development server:

```bash
npm run dev
```

Visit <http://localhost:4321> to see the application.

**Email Testing (Mailpit):**
When running Supabase locally, emails are intercepted by Mailpit. View them at <http://localhost:54324/>.

### Supabase Auth Email Templates (Local)

Local Supabase Auth emails (confirm signup, reset password, etc.) can be customized via `supabase/config.toml`.
This repo includes a styled confirmation email template that matches the app’s notification email look:

- `supabase/templates/auth-confirmation.html` (`content_path = "./supabase/templates/auth-confirmation.html"`)
- `supabase/templates/auth-recovery.html` (`content_path = "./supabase/templates/auth-recovery.html"`)
- `supabase/templates/auth-email-change.html` (`content_path = "./supabase/templates/auth-email-change.html"`)
- `supabase/templates/auth-password-changed.html` (`content_path = "./templates/auth-password-changed.html"`)

## Testing

GitHub CI runs the full test battery on every PR and `main` push. Local DB-backed tests are **opt-in** — see [tests/README.md](tests/README.md).

```bash
# Debugging only (requires local Supabase + ALLOW_LOCAL_DB_TESTS=1):
npm run db:start
npm run db:reset
ALLOW_LOCAL_DB_TESTS=1 npm test
ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e
```

For local debugging, run `npm run db:reset` before tests to ensure your Supabase DB matches the current migrations and seed data.

### CI (GitHub Actions + local pre-commit gate)

**GitHub Actions** runs the full test battery on every PR, merge queue entry if the feature becomes available, and `main` push: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (Biome, YAML, actionlint, types, Knip, SQL/squawk, migration grants, Lambda bundle build, local Supabase, unit + E2E, build). [`.github/workflows/auto-merge.yml`](.github/workflows/auto-merge.yml) enables squash auto-merge only on PRs labeled `ship-auto-merge` (orchestrated via `/ship`). [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys production after `main` CI passes.

The **local pre-commit hook** (`.git-hooks/pre-commit`) runs lint, types, and static checks only — no local Supabase, no unit/E2E, no deploy credentials. See [docs/github-ci.md](docs/github-ci.md) for the full command split, branch protection, production environment secrets, and deploy setup.

Deploy is **GitHub-managed** after merge: Vercel's GitHub integration deploys the web tier from `main`, and after `main` CI passes the production deploy workflow runs `aws/deploy-web.sh --deploy-ci`, applies Supabase migrations, updates Lambda code, and invokes the live-provider check. `npm run deploy:code` remains a local break-glass path.

Because Vercel Git deployments start independently on `main` pushes, schema-affecting web changes should stay backward-compatible with the currently deployed database until the GitHub deploy workflow has applied migrations. Use the local break-glass deploy only when an explicitly ordered DB/Lambda/web release is required.

### Live provider validation

Vitest runs fully offline and stubs every external provider key (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `XAI_API_KEY`); SES and Telegram are always faked in tests. There is **no way to run live provider tests locally** — the provider keys live only in the Lambda runtime (SAM params).

Real Massive/Finnhub round-trips are exercised in production by the scheduled `stocktextalerts-live-provider-check` Lambda ([src/handlers/maintenance/live-provider-check.ts](src/handlers/maintenance/live-provider-check.ts)), which throws on any failure and surfaces it through the standard Lambda error alarm. The GitHub deploy workflow invokes it after every production deploy; invoke it on demand with `aws lambda invoke` only for investigation.

## Usage

### User Flow

1. **Register** - Create an account with email
2. **Set Settings** - Configure timezone and notification schedule
3. **Add Assets** - Search and add assets to track
4. **Link Telegram** (optional) - Connect your Telegram account via the bot
5. **Receive Notifications** - Get your asset updates via email and/or Telegram

### API Endpoints

**Authentication:**

- `POST /api/auth/email/register`
- `POST /api/auth/email/forgot-password`
- `POST /api/auth/email/resend-verification`
- `POST /api/auth/signin`
- `GET /api/auth/signout` (renders a confirmation page; does not sign you out)
- `POST /api/auth/signout`
- Account management:
  - `POST /api/auth/account-management/update-email`
  - `POST /api/auth/account-management/change-password`
  - `POST /api/auth/account-management/delete-account`
  - `POST /api/auth/account-management/update-password`

**Notification settings:**  
The canonical endpoint for fetching current user preferences is `GET /api/notification-preferences/current`.

- `GET /api/notification-preferences/current`
- `POST /api/notification-preferences/update`
- `POST /api/profile/timezone`
- `POST /api/profile/dismiss-timezone-banner`
- `POST /api/profile/time-format`

## Deployment to Vercel

### 1. Add Environment Variables

Do not mirror `.env.local` into Vercel 1:1.

Add the runtime variables your **Vercel SSR app** needs (Settings → Environment Variables):

- `UNSUBSCRIBE_TOKEN_SECRET` — verify `/unsubscribe` links (must match the Lambda value)
- `MASSIVE_API_KEY` — asset logo proxy (`/api/assets/logo/...`)
- Supabase integration vars (if not using the Vercel Supabase integration)

Do **not** add to Vercel (Lambda-only via `aws/` SAM deploy):

- `FINNHUB_API_KEY`, `XAI_API_KEY` — provider calls in scheduled handlers
- `DATABASE_URL`, `DEFAULT_PASSWORD`, `VERCEL_URL`

SES notification sending runs on Lambda (`EMAIL_FROM` from SSM `/stocktextalerts/email-from`; no `AWS_*` keys on Vercel or in SAM parameter overrides).

**Important for Astro 7 SSR:**

- Vercel builds with **Vite 8 / Rolldown** automatically via the Git integration — no extra bundler config.
- Ensure variables are available for **Production** and **Preview** (sensitive secrets cannot target Vercel Development — use `.env.local` / `vercel env pull` locally)
- Enable "Available during Build" so `import.meta.env` and `astro:env` work in serverless functions

### 1a. Deploy creds and live provider keys

- **GitHub deploy creds:** `DATABASE_URL_PROD` lives in the GitHub `Production` environment; non-secret deploy variables live there too (`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `PRODUCTION_SITE_URL`). Vercel web deploys use the connected Vercel GitHub integration, so Actions does not need `VERCEL_TOKEN`, `VERCEL_ORG_ID`, or `VERCEL_PROJECT_ID`. Local `.env.local` deploy creds remain for break-glass `npm run deploy:code`.
- **Live provider keys** (`MASSIVE_API_KEY`, `FINNHUB_API_KEY`): SAM params (gitignored `.env.local`), used by the runtime + `stocktextalerts-live-provider-check` Lambdas.

### 2. Deploy

Push to your main branch or click "Redeploy" in Vercel. The application will automatically build and deploy.

### 3. AWS Lambda Crons

Notification crons run as AWS Lambda functions deployed via SAM (see `aws/`). EventBridge Scheduler triggers them automatically.

**`ScheduleFunction`** (every minute) — main notification pipeline:

1. Runs price-move alerts during US market hours (Massive snapshot quotes)
2. Runs scheduled asset price notifications (batched via Massive snapshot quotes)
3. Sends asset events notifications (earnings/dividends/splits/IPOs/analyst/insider) at the user’s daily delivery time
4. Sends daily digest notifications (News/Rumors) at the user’s chosen daily time
5. Sends via email and/or Telegram based on settings and logs attempts to the `notification_log` table

**`AssetMaintenanceFunction`** (daily at 00:00 UTC) — pre-populates the `asset_events` table with earnings, dividends, splits, and IPOs; runs Finnhub analyst/insider enrichment, the asset-universe reconcile, and the delisting sweep.

**`ComputeDailyStatsFunction`** (weekdays at 22:00 UTC) — caches per-symbol daily closes in `asset_daily_closes` (the source for the dashboard watchlist sparklines) for tracked assets.

**Local testing:** `cd aws && npm run local:test-all` builds and invokes all three functions locally via `sam local invoke` (requires Podman or Docker — SAM CLI uses `DOCKER_HOST`). To test a single function: `npm run local:schedule`, `npm run local:asset-maintenance`, or `npm run local:daily-stats`. Run `npm run local:gen-env` first to generate `env.json` from `.env.local` with per-function env var scoping.

**Deploying:** merge through GitHub. Vercel's GitHub integration deploys the web tier from the landed `main` commit. After that commit passes CI, `.github/workflows/deploy.yml` runs Supabase migrations → Lambda code via `update-function-code` (code-only, under the scoped GitHub OIDC deploy role) → live-provider check. **A full SAM deploy (`npm run deploy:infra`) is still required whenever `aws/template.yaml` or `aws/deploy.sh` changes** (infrastructure/config) — that stays a manual admin step, not part of the GitHub code deploy.

## Project Structure

- `src/components/`: Astro + Vue UI components (landing, dashboard, profile)
- `src/layouts/`: Base layouts
- `src/pages/`: Routes and API endpoints
- `src/lib/`: Server logic (auth, db, providers, market-notifications, daily-digest, asset-events, messaging, schedule, time, logging)
- `supabase/`: Local Supabase config + migrations
- `scripts/`: Seed generation utilities and asset data
- `tests/`: Vitest + Playwright tests
- `public/`: Static assets (favicons, Open Graph image)

## Security Features

- Row Level Security (RLS) on all database tables (authenticated users have SELECT-only on assets; service_role handles sector updates)
- URL sanitization in notification links (only http/https allowed in headline URLs, blocks javascript:, data:, etc.)
- Cron endpoint protected by secret header
- Rate limiting on sensitive actions: password change (`CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS` / `CHANGE_PASSWORD_RATE_LIMIT_MINUTES`), email change (`CHANGE_EMAIL_RATE_LIMIT_ATTEMPTS` / `CHANGE_EMAIL_RATE_LIMIT_MINUTES`), and account deletion (`DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS` / `DELETE_ACCOUNT_RATE_LIMIT_MINUTES`); defaults: 5 attempts per 15 minutes for each
- Service role key never exposed to client
- Traditional form submissions (some UI components like Vue dashboard panels and autosave maintain client-side state)

## Adding More Assets

The asset data is imported from `scripts/data/us-assets.json`. To update the asset list:

### JSON Structure

The `scripts/data/us-assets.json` file must follow this structure:

```json
{
  "metadata": {
    "source": "https://finnhub.io/api/v1/stock/symbol?exchange=US",
    "fetched_at": "2026-02-09T00:00:00Z",
    "type_counts": { "stock": 6000, "etf": 3000 },
    "total_symbols": 9000
  },
  "data": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc. Common Stock",
      "type": "stock"
    },
    {
      "symbol": "SPY",
      "name": "SPDR S&P 500 ETF Trust",
      "type": "etf"
    }
  ]
}
```

**Required fields:**

- `data` (array) - Array of asset objects
- Each asset object must have:
  - `symbol` (string, required) - Ticker symbol (max 10 characters)
  - `name` (string, required) - Asset name (max 255 characters)
  - `type` (string, required) - Asset type (`"stock"` or `"etf"`)

**Optional fields:**

- `metadata` (object) - Metadata about the data source (not imported, for reference only)

See `scripts/data/us-assets.json` for the canonical schema and example data.

### Update Process

1. Run `npm run db:fetch-assets` to fetch updated asset data from Finnhub, or update `scripts/data/us-assets.json` manually
2. Regenerate the seed file:

    ```bash
    npm run db:generate-seed
    ```

3. Reset the local database to apply the new seed data:

    ```bash
    npm run db:reset
    ```

### Data Reset Warning

Resetting the database (`npm run db:reset`) will:

- Delete all existing data (users, notification-preferences, tracked assets)
- Re-apply the schema
- Re-seed the database with the updated asset list

This is safe for local development as long as your env vars point to your local Supabase instance.

`db:generate-seed` generates `supabase/seed.sql` against whatever Supabase instance `SUPABASE_URL` points to, so be careful when running it against production.

Important: `db:generate-seed` will include users from `scripts/data/users.json` **if that file exists** (it is gitignored). Those users are created with passwords derived from `DEFAULT_PASSWORD` in `.env.local`.

## License

MIT
