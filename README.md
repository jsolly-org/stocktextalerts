# StockTextAlerts.com 📈

A stock market notification app that sends scheduled SMS and email updates about tracked stocks. Built with Astro, deployed on Vercel, with Supabase authentication and a PostgreSQL database. Email and SMS are sent via Resend and Twilio.

## Features

- **Stock Tracking** - Search and track US stock symbols
- **Email Notifications** - Daily digest email updates about tracked stocks (Resend)
- **SMS Notifications** - Optional daily digest SMS messages (Twilio)
- **Phone Verification** - Secure phone verification via Twilio Verify
- **Timezone Support** - Browser-detected timezones with user overrides
- **Daily Digest Scheduling** - Choose the time for your daily digest
- **SMS Opt-out** - Users can reply STOP to opt out of SMS
- **CAPTCHA Protection** - hCaptcha for auth flows

## Tech Stack

- **Framework**: Astro 5 with SSR
- **UI**: Vue 3 components with Tailwind CSS
- **Icons**: Local SVGs in `/src/icons` loaded via `astro-icon` in `.astro` files; Vue components import SVGs via `vite-svg-loader` using the `?component` suffix
- **Database**: Supabase (PostgreSQL)
- **Email**: Resend
- **SMS**: Twilio Verify API + Messaging API
- **Hosting**: Vercel with Cron Jobs
- **Phone Validation**: libphonenumber-js
- **Search**: Fuse.js for fuzzy stock search
- **Linting**: Biome (no ESLint or Prettier)
- **Testing**: Vitest + Playwright

## Design System

- **Tokens**: Semantic color tokens live in `src/global.css` via Tailwind v4 `@theme`.
- **Status UI**: Use `StatusMessage.astro` / `StatusMessage.vue` or the `status-tone-*` classes for alerts.
- **Neutrals**: Prefer `gray-*` utilities for borders, text, and surfaces.

## Prerequisites

- Node.js (see `.nvmrc` for the required version)
- Docker (Docker Desktop or Docker Engine)
- Supabase account
- Resend account
- Twilio account with Verify API enabled
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

**Supabase Auth CAPTCHA (hCaptcha):**
1. Create a site in the hCaptcha dashboard and copy the **Sitekey** + **Secret Key**
2. In Supabase Dashboard, enable CAPTCHA protection: Project Settings → Auth → Bot and Abuse Protection → **Enable CAPTCHA protection**
3. Select **hCaptcha** and paste the **Secret Key**
4. For local development, use hCaptcha's test keys or a test sitekey:
   - **Option A (recommended):** hCaptcha test keys (always pass)
     - Site Key: `10000000-ffff-ffff-ffff-000000000001`
     - Secret Key: `0x0000000000000000000000000000000000000000`
   - **Option B:** Create a separate test sitekey and add `127.0.0.1` as an allowed domain

**Resend:**
1. Go to [resend.com](https://resend.com) and create an account
2. Create an API key and verify a sending domain or email

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

Create a `.env.local` file in the root directory (you can copy from `env.example` and fill in secrets). This file is gitignored and **must not** be committed.

```env
# Site Configuration
# VERCEL_URL is automatically set by Vercel for all deployments.
# For local development, set it manually:
VERCEL_URL=http://localhost:4321

# Supabase
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:password@host:5432/database

# hCaptcha (site key is public)
PUBLIC_HCAPTCHA_SITE_KEY=your-hcaptcha-site-key
HCAPTCHA_SECRET_KEY=your-hcaptcha-secret-key

# Twilio
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=your-verify-service-sid

# Vercel
CRON_SECRET=your-random-secret-string

# Resend
RESEND_API_KEY=REPLACE_WITH_YOUR_API_KEY
EMAIL_FROM=notifications@updates.example.com

# Logging
LOG_MASK_PII=true

# Seed Data (Local Development)
DEFAULT_PASSWORD=your-strong-local-seed-password
```

**Where to find these:**
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`: Supabase Dashboard → Project Settings → API
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase Dashboard → Project Settings → API (under "Service role")
- `DATABASE_URL`: Supabase Dashboard → Project Settings → Database → Connection String → Transaction mode (pooler)
- Twilio credentials: Twilio Console → Account Dashboard
- `CRON_SECRET`: Generate a random string (e.g., `openssl rand -hex 32`)
- Resend credentials: Resend Dashboard → API Keys
- hCaptcha secret: hCaptcha Dashboard → Settings → **Secret key**
- LOG masking: optional, defaults to true

**Security Note:** The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. Never expose it on the client side. The `.env.local` file (and all `.env*` files) are excluded from version control via `.gitignore`.

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
- `supabase/seed.sql` is auto-generated by `scripts/generate-seed.ts` and is gitignored
- The seed file includes test user passwords that are generated from `DEFAULT_PASSWORD`
- Always regenerate `seed.sql` after updating `scripts/users.json` or `scripts/us-stocks.json`
- To add test users, copy `scripts/sample-users.json` to `scripts/users.json` (no passwords needed)

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

## Testing

```bash
npm run db:start
npm run test
npm run test:ci
npm run test:e2e
npm run fix
```

For local development, `npm run test` runs `npm run db:reset` first to ensure your Supabase DB matches the current migrations and seed data. CI uses `npm run test:ci` to skip the automatic reset (faster on fresh runners).

## Usage

### User Flow

1. **Register** - Create an account with email
2. **Set Settings** - Configure timezone and daily digest time
3. **Add Stocks** - Search and add stocks to track
4. **Enable SMS** (optional) - Add phone number and verify via SMS code
5. **Receive Notifications** - Get your daily digest via email and/or SMS

### API Endpoints

**Authentication:**
- `POST /api/auth/email/register`
- `POST /api/auth/email/forgot-password`
- `POST /api/auth/email/resend-verification`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `POST /api/auth/delete-account`
- `POST /api/auth/update-password`
- `POST /api/auth/sms/send-verification`
- `POST /api/auth/sms/verify-code`

**Notifications & Preferences:**
- `GET /api/preferences/current`
- `POST /api/preferences/update`
- `POST /api/preferences/timezone`
- `POST /api/preferences/dismiss-timezone-banner`
- `POST /api/notifications/scheduled` (cron, protected by `CRON_SECRET`)
- `POST /api/notifications/sms/inbound` (Twilio webhook for STOP/START/HELP)

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
3. Under "Messaging", set the webhook URL to: `https://yourdomain.com/api/notifications/sms/inbound`
4. Save changes

### 4. Verify Cron Job

The `vercel.json` file configures a scheduled cron job that runs at minute 0 of every hour.

The cron job calls `/api/notifications/scheduled` and must include:
- `Authorization: Bearer <CRON_SECRET>`

The cron job:
1. Queries users who need notifications based on their timezone and daily digest time
2. Fetches their tracked stocks
3. Sends via email and/or SMS based on settings
4. Logs all notification attempts to `notification_log` table

## Project Structure

- `src/components/`: Astro + Vue UI components (landing, dashboard, profile)
- `src/layouts/`: Base layouts
- `src/pages/`: Routes and API endpoints
- `src/lib/`: Server utilities (auth, db, logging, time)
- `supabase/`: Local Supabase config + migrations
- `scripts/`: Seed generation utilities and stock data
- `tests/`: Vitest + Playwright tests
- `public/`: Static assets (favicons, Open Graph image)

## Security Features

- Row Level Security (RLS) on all database tables
- CAPTCHA protection for anonymous auth flows (Supabase Auth + hCaptcha)
- Cron endpoint protected by secret header
- Phone verification via Twilio Verify API
- SMS opt-out support (STOP keyword compliance)
- Service role key never exposed to client
- Traditional form submissions (some UI components like Vue dashboard panels and autosave maintain client-side state)

## Adding More Stocks

The stock data is imported from `scripts/us-stocks.json`. To update the stock list:

### JSON Structure

The `scripts/us-stocks.json` file must follow this structure:

```json
{
  "metadata": {
    "source": "https://github.com/rreichel3/US-Stock-Symbols",
    "fetched_at": "2025-11-08T15:18:17Z",
    "exchanges": ["NASDAQ", "NYSE", "AMEX"],
    "total_symbols": 7036
  },
  "data": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc. Common Stock",
      "exchange": "NASDAQ"
    },
    {
      "symbol": "MSFT",
      "name": "Microsoft Corporation Common Stock",
      "exchange": "NASDAQ"
    }
  ]
}
```

**Required fields:**
- `data` (array) - Array of stock objects
- Each stock object must have:
  - `symbol` (string, required) - Stock ticker symbol (max 10 characters)
  - `name` (string, required) - Company name (max 255 characters)
  - `exchange` (string, required) - Exchange name (e.g., "NASDAQ", "NYSE", "AMEX")

**Optional fields:**
- `metadata` (object) - Metadata about the data source (not imported, for reference only)

See `scripts/us-stocks.json` for the canonical schema and example data.

### Update Process

1. Fetch updated stock data from [US Stock Symbols](https://github.com/rreichel3/US-Stock-Symbols) or your preferred source
2. Update `scripts/us-stocks.json` with the new data (must match the JSON structure above)
3. Regenerate the seed file:

```bash
npm run db:generate-seed
```

4. Reset the local database to apply the new seed data:

```bash
npm run db:reset
```

### Data Reset Warning

Resetting the database (`npm run db:reset`) will:
- Delete all existing data (users, preferences, tracked stocks)
- Re-apply the schema
- Re-seed the database with the updated stock list

This is safe for local development but **do not run this against a production database**.

## License

MIT
