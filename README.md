# 📈 StockTextAlerts.com

A securities notification app that sends scheduled SMS and email updates (scheduled asset price notifications, daily digests, and asset events) plus optional asset price alerts about tracked assets (stocks and ETFs). Built with Astro, deployed on Vercel, with Supabase authentication and a PostgreSQL database. Email and SMS are sent via Resend and Twilio. 🔔

## Features

- **Asset Tracking** - Search and track US stocks and ETFs
- **Email Notifications** - Receive updates via email (Resend)
- **SMS Notifications** - Optional SMS delivery (Twilio)
- **Asset Price Alerts** - Get alerted during US market hours when tracked assets show significant price movement (up or down), with configurable sensitivity (Chill/Balanced/Aggressive)
- **Phone Verification** - Secure phone verification via Twilio Verify
- **Timezone Support** - Browser-detected timezones with user overrides
- **Market Notifications** - Choose up to 5 delivery times for scheduled asset price updates, and decide if they're delivered by email, SMS, or both
- **Daily Digest** - Once-daily email digest with optional extras (News/Rumors are email-only and may include clickable source links)
- **Asset Events** - Daily notification of upcoming calendar events (earnings/dividends/splits) and IPOs, plus optional insider trades and analyst consensus (delivered by email and/or SMS; calendar events are toggled together per channel)
- **Format Preferences** - Customize how your updates look with live SMS/email previews
- **SMS Opt-out** - Reply STOP to opt out of SMS; reply START to opt back in (then re-enable SMS in your dashboard)

## Tech Stack

- **Framework**: Astro 5 with SSR
- **UI**: Vue 3 components with Tailwind CSS
- **Icons**: Local SVGs in `/src/icons` loaded via `astro-icon` in `.astro` files; Vue components import SVGs via `vite-svg-loader` using the `?component` suffix
- **Database**: Supabase (PostgreSQL)
- **Market Data**: Massive (prices/dividends/splits/IPOs) + Finnhub (earnings, market hours, analyst/insider extras)
- **AI Summaries**: xAI (Grok) for optional News/Rumors add-ons and asset price alert summaries
- **Email**: Resend
- **SMS**: Twilio Verify API + Messaging API
- **Hosting**: Vercel with Cron Jobs
- **Phone Validation**: libphonenumber-js
- **Search**: Finnhub symbol lookup API (server-side)
- **Linting**: Biome (no ESLint or Prettier)
- **Testing**: Vitest + Playwright

## Design System

- **Tokens**: Semantic color tokens live in `src/global.css` via Tailwind v4 `@theme`.
- **Status UI**: Use `StatusMessage.astro` / `StatusMessage.vue` or the `status-tone-*` classes for alerts.
- **Neutrals**: Prefer semantic surface/text/border tokens (e.g. `bg-surface`, `text-heading`, `border-edge`, `text-muted`) and only reach for `gray-*` utilities when a token doesn't exist.

## Prerequisites

- Node.js (see `.nvmrc` for the required version)
- Docker (Docker Desktop or Docker Engine)
- Supabase account
- Twilio account with Verify API enabled
- Massive account (API key)
- Finnhub account (API key)
- xAI account (optional, only needed for News/Rumors add-ons)
- Vercel account (for deployment and cron jobs)

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

**Twilio:**
1. Go to [twilio.com](https://www.twilio.com) and create an account
2. Purchase a phone number (or use trial number)
3. Create a Verify Service in Console → Verify → Services
4. Note your Account SID, Auth Token, Phone Number, and Verify Service SID

**Vercel:**
1. Push your code to GitHub (if you haven't already)
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Don't deploy yet - add environment variables first

### 3. Environment Variables

> **Note:** Where possible, use official [Supabase integrations](https://supabase.com/docs/guides/platform/marketplace) (e.g. Resend, Twilio) instead of manually managing API keys as environment variables. Integrations are configured in the Supabase Dashboard and inject credentials automatically — no env vars needed.

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

# Twilio
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=your-verify-service-sid

# Vercel
CRON_SECRET=your-random-secret-string

EMAIL_FROM=notifications@updates.example.com

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
- Twilio credentials: Twilio Console → Account Dashboard
- `CRON_SECRET`: Generate a random string (e.g., `openssl rand -hex 32`)
- Massive credentials: Massive Dashboard → API Keys
- Finnhub credentials: Finnhub Dashboard → API Keys
- xAI credentials: xAI Console → API Keys
- LOG masking: optional, defaults to true

**Security Note:** The `SUPABASE_SECRET_KEY` bypasses Row Level Security. Never expose it on the client side. The `.env.local` file (and all `.env*` files) are excluded from version control via `.gitignore`.

### 4. Generate Seed File

The `db:generate-seed` script tries to list existing Supabase Auth users (via `supabase.auth.admin.listUsers()`) so it can reuse IDs when regenerating `supabase/seed.sql`. If Supabase isn't running or Auth isn't ready yet, it will still generate a valid seed file with new UUIDs.

Start Supabase (recommended):

```bash
npx supabase start
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

- `supabase/auth-confirmation.html` (wired up via `[auth.email.template.confirmation]`)
- `supabase/auth-recovery.html` (wired up via `[auth.email.template.recovery]`)
- `supabase/auth-email-change.html` (wired up via `[auth.email.template.email_change]`)

### 6. Expose Local Webhooks (ngrok)

If you want Twilio inbound SMS webhooks (STOP/START/HELP) to hit your local dev server, expose port 4321 with ngrok and point Twilio at the public URL.

1. Install ngrok and authenticate (see [ngrok setup](https://ngrok.com/docs/getting-started/)).
2. Start a tunnel to your local dev server:

```bash
ngrok http 4321
```

3. Copy the `https://...ngrok-free.app` (or similar) forwarding URL and set it as `VERCEL_URL` in `.env.local`:

```env
VERCEL_URL=https://YOUR_NGROK_HOSTNAME
```

4. Restart `npm run dev` so the app uses the new base URL.
5. In Twilio Console → Phone Numbers → Messaging, set the inbound webhook to:
   - `https://YOUR_NGROK_HOSTNAME/api/messaging/inbound`

## Testing

```bash
npm run db:start
npm run db:reset
npm run test
npm run test:ci
npm run test:e2e
npm run fix
```

For local development, run `npm run db:reset` before `npm run test` to ensure your Supabase DB matches the current migrations and seed data.

### GitHub Actions (Local)

Run the pull request CI workflow locally with `act`:

```bash
npm run gha:local
```

Run only a single CI job:

```bash
npm run gha:local:lint
npm run gha:local:test-build
```

Full setup and troubleshooting: `docs/testing-github-actions-locally.md`

### Optional: Live Provider Tests (Massive/Finnhub/xAI)

Vitest runs offline by default and stubs external provider keys. To opt into one or more real providers for targeted integration tests, pass `--live` to `npm test`:

```bash
# Massive only
npm test -- --live=massive tests/lib/live-provider-apis.test.ts

# Finnhub only
npm test -- --live=finnhub tests/lib/live-provider-apis.test.ts

# Both Massive + Finnhub
npm test -- --live=massive,finnhub tests/lib/live-provider-apis.test.ts

# xAI (Grok) only
npm test -- --live=xai tests/lib/live-xai-apis.test.ts

# Package scripts
npm run test:live:data
npm run test:live:xai
```

Notes:
- `MASSIVE_API_KEY`, `FINNHUB_API_KEY`, and/or `XAI_API_KEY` must be present in your environment when enabled.
- Twilio and Resend remain fake/stubbed in tests.

## Usage

### User Flow

1. **Register** - Create an account with email
2. **Set Settings** - Configure timezone and notification schedule
3. **Add Assets** - Search and add assets to track
4. **Enable SMS** (optional) - Add phone number and verify via SMS code
5. **Receive Notifications** - Get your asset updates via email and/or SMS

### API Endpoints

**Authentication:**
- `POST /api/auth/email/register`
- `POST /api/auth/email/forgot-password`
- `POST /api/auth/email/resend-verification`
- `POST /api/auth/signin`
- `GET /api/auth/signout` (renders a confirmation page; does not sign you out)
- `POST /api/auth/signout`
- `POST /api/auth/delete-account`
- `POST /api/auth/update-email`
- `POST /api/auth/update-password`
- `POST /api/auth/change-password`
- `POST /api/auth/sms/send-verification`
- `POST /api/auth/sms/verify-code`

**Notification settings:**  
The canonical endpoint for fetching current user preferences is `GET /api/notification-preferences/current`.
- `GET /api/notification-preferences/current`
- `POST /api/notification-preferences/update`
- `POST /api/notification-preferences/timezone`
- `POST /api/notification-preferences/dismiss-timezone-banner`
- `POST /api/schedule` (cron, protected by `CRON_SECRET`)
- `POST /api/messaging/inbound` (Twilio webhook for STOP/START/HELP)

## Deployment to Vercel

### 1. Add Environment Variables

In your Vercel project settings (Settings → Environment Variables), add all variables from your `.env.local` file.

**Important for Astro SSR:**
- Ensure variables are available for **Production**, **Preview**, and **Development**
- Enable "Available during Build" so `import.meta.env` works in serverless functions

### 2. Deploy

Push to your main branch or click "Redeploy" in Vercel. The application will automatically build and deploy.

### 3. Configure Twilio Webhook

After deployment, configure the Twilio webhook for incoming SMS:
1. Go to Twilio Console → Phone Numbers → Manage → Active numbers
2. Select your phone number
3. Under "Messaging", set the webhook URL to: `https://yourdomain.com/api/messaging/inbound`
4. Save changes

### 4. Verify Cron Jobs

The `vercel.json` file configures three cron jobs. All must include `Authorization: Bearer <CRON_SECRET>`.

**`/api/schedule`** (runs every minute) — main notification pipeline:
1. Runs asset price alerts during US market hours (Massive snapshot quotes)
2. Runs scheduled asset price notifications (batched via Massive snapshot quotes)
3. Sends asset events notifications (earnings/dividends/splits/IPOs/analyst/insider) at the user’s daily delivery time
4. Sends daily digest notifications (News/Rumors) at the user’s chosen daily time
5. Sends via email and/or SMS based on settings and logs attempts to the `notification_log` table

**`/api/asset-events`** (runs daily at 00:00 UTC) — pre-populates the `asset_events` table with earnings, dividends, splits, and IPOs.

**`/api/sector-backfill`** (runs weekly on Sunday at 06:00 UTC) — backfills missing sector metadata on tracked assets.

## Project Structure

- `src/components/`: Astro + Vue UI components (landing, dashboard, profile)
- `src/layouts/`: Base layouts
- `src/pages/`: Routes and API endpoints
- `src/lib/`: Server utilities (auth, db, logging, time)
- `supabase/`: Local Supabase config + migrations
- `scripts/`: Seed generation utilities and asset data
- `tests/`: Vitest + Playwright tests
- `public/`: Static assets (favicons, Open Graph image)

## Security Features

- Row Level Security (RLS) on all database tables
- Cron endpoint protected by secret header
- Phone verification via Twilio Verify API
- SMS opt-out support (STOP keyword compliance)
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
