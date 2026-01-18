# Stock Notification Dashboard 📈📱

A stock notification application that sends scheduled SMS and email updates about tracked stocks. Built with Astro, deployed on Vercel, with Supabase authentication and PostgreSQL database.

## Features

- 📊 **Stock Tracking** - Search and track your favorite stocks (AAPL, MSFT, GOOGL, etc.)
- 📧 **Email Notifications** - Receive daily digest email updates about your tracked stocks
- 📱 **SMS Notifications** - Optional daily digest SMS messages via Twilio
- 📞 **Phone Verification** - Secure phone verification via Twilio Verify
- 🌍 **Timezone Support** - All US timezones with browser auto-detection
- ⏰ **Daily Digest Scheduling** - Choose the time for your daily digest
- 🔕 **SMS Opt-out** - Users can reply STOP to opt out of SMS

## Tech Stack

- **Framework**: Astro 5 with SSR
- **UI**: Vue 3 components with Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **SMS**: Twilio Verify API + Messaging API
- **Hosting**: Vercel with Cron Jobs
- **Phone Validation**: libphonenumber-js
- **Search**: Fuse.js for fuzzy stock search
- **Linting**: Biome (no ESLint or Prettier)
- **Testing**: Vitest

## Prerequisites

- Node.js (see `.nvmrc` for the required version)
- Docker (Docker Desktop or Docker Engine)
- Supabase account
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
4. **For local development:** Use hCaptcha's test keys (recommended) or create a test sitekey:
   - **Option A (Recommended):** Use hCaptcha's official test keys that always pass:
     - Site Key: `10000000-ffff-ffff-ffff-000000000001`
     - Secret Key: `0x0000000000000000000000000000000000000000`
     - **Note:** hCaptcha prohibits `localhost` and `127.0.0.1` per their developer guide. To use test keys locally, either:
       - Map `127.0.0.1` to a hosts-file alias (e.g., `test.localhost`) in `/etc/hosts`
       - Run against a non-local host or configured test domain
     - Production sitekey/secret must be used in Vercel/production environments
   - **Option B:** Create a separate test sitekey in hCaptcha dashboard:
     - Create a new site (e.g., "StockTextAlerts - Local Dev")
     - Add `127.0.0.1` to allowed domains (note: `localhost` may not be accepted)
     - Use this test sitekey/secret in your `.env.local` file
   - Use your production sitekey/secret in production environment variables (Vercel)

**Twilio:**
1. Go to [twilio.com](https://www.twilio.com) and create an account
2. Purchase a phone number (or use trial number)
3. Create a Verify Service in Console → Verify → Services
4. Note your Account SID, Auth Token, Phone Number, and Verify Service SID

**Vercel:**
1. Push your code to GitHub (if you haven't already)
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Don't deploy yet - we'll add environment variables first

### 3. Environment Variables

Create a `.env.local` file in the root directory (you can copy from `env.example` and fill in secrets). This file is gitignored and **must not** be committed.

```env
# Site Configuration
# VERCEL_URL is automatically set by Vercel for all deployments.
# For local development, set it manually:
VERCEL_URL=http://localhost:4321

# Supabase Configuration
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:password@host:5432/database

# Twilio Configuration
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=your-verify-service-sid

# Vercel Cron Configuration
CRON_SECRET=your-random-secret-string

# Resend Configuration
RESEND_API_KEY=re_123456789
EMAIL_FROM=notifications@updates.example.com

# hCaptcha (site key is public; secret key is server-only)
PUBLIC_HCAPTCHA_SITE_KEY=your-hcaptcha-site-key
HCAPTCHA_SECRET_KEY=your-hcaptcha-secret-key

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

**Security Note:** The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. Never expose it on the client side. The `.env.local` file (and all `.env*` files) are already excluded from version control via `.gitignore`; keep secrets only in environment files or your deployment platform, not in committed code.

### 4. Generate Seed File

The `db:generate-seed` script requires a running Supabase instance because `scripts/generate-seed.ts` calls `supabase.auth.admin.listUsers()`.

Start Supabase first:

```bash
# Start Supabase (requires Docker)
npx supabase start
```

Then generate the seed file (this uses your `DEFAULT_PASSWORD` from `.env.local`):

```bash
npm run db:generate-seed
```

This creates `supabase/seed.sql` with test user data.

**Important Notes:**
- `supabase/seed.sql` is **auto-generated** by `scripts/generate-seed.ts` and is **gitignored** (not committed to source control)
- The seed file includes test user passwords that are generated from the `DEFAULT_PASSWORD` environment variable
- SQL files cannot access environment variables directly, which is why we use the generation script
- Always regenerate `seed.sql` using `npm run db:generate-seed` after updating `scripts/users.json` or `scripts/us-stocks.json`
- Each developer should generate their own `seed.sql` using their local `DEFAULT_PASSWORD` from `.env.local`
- To add test users, copy `scripts/sample-users.json` to `scripts/users.json` and update with your test data (do not include passwords - they will use `DEFAULT_PASSWORD` from `.env.local`)

### 5. Start Local Development

After generating `supabase/seed.sql`, reset Supabase to load the seed:

```bash
npx supabase db reset
```

Start the Astro development server:

```bash
# Start Astro dev server
npm run dev
```

`supabase db reset` will:
1. Re-apply database migrations from `supabase/migrations`
2. Re-seed the database from `supabase/seed.sql`

Visit <http://localhost:4321> to see the application.

**Email Testing (Mail Pit):**

When running Supabase locally, all emails (verification emails, password resets, etc.) are intercepted by Mail Pit instead of being sent. You can view these emails at <http://localhost:54324/>.

This is useful for:
- Testing email verification flows
- Viewing password reset links
- Inspecting email content and formatting
- Testing without sending real emails

### 6. (Optional) Update Stock Tickers

The database is pre-seeded with stock data. If you need to update the list of available stocks:

1. Update `scripts/us-stocks.json`
2. Generate a new seed file:
   ```bash
   npm run db:generate-seed
   ```
3. Reset the database to apply changes:
   ```bash
   npx supabase db reset
   ```

## Usage

### User Flow

1. **Register** - Create an account with email
2. **Set Settings** - Configure timezone and daily digest time
3. **Add Stocks** - Search and add stocks to track
4. **Enable SMS** (optional) - Add phone number and verify via SMS code
5. **Receive Notifications** - Get your daily digest via email and/or SMS

### API Endpoints

**Authentication:**
- `POST /api/auth/email/register` - User registration
- `POST /api/auth/email/forgot-password` - Request password reset
- `POST /api/auth/email/resend-verification` - Resend verification email
- `POST /api/auth/signin` - User signin
- `POST /api/auth/signout` - User signout
- `POST /api/auth/delete-account` - Delete user account
- `POST /api/auth/update-password` - Update password from reset link
- `POST /api/auth/sms/send-verification` - Send SMS verification code
- `POST /api/auth/sms/verify-code` - Verify SMS code

**Notifications & Preferences:**
- `POST /api/preferences` - Update notification preferences and tracked stocks
- `POST /api/notifications/scheduled` - Cron endpoint (protected by CRON_SECRET)
- `POST /api/notifications/sms/inbound` - Twilio webhook for STOP/START/HELP keywords

## Deployment to Vercel

### 1. Add Environment Variables

In your Vercel project settings (Settings → Environment Variables), add all variables from your `.env.local` file:
- `VERCEL_URL` - Not needed on Vercel. This is automatically set by Vercel for all deployments.
- `PUBLIC_SUPABASE_URL`
- `PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `TWILIO_VERIFY_SERVICE_SID`
- `CRON_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`

**Important for Astro SSR:**
- For each environment variable, ensure it's available for **Production**, **Preview**, and **Development** environments (or at least the ones you're using)
- **Enable "Available during Build"** for all variables - this is required for Astro's `import.meta.env` to work in serverless functions
- You can find this option when adding/editing each variable in the Vercel dashboard

**Note:** You don't need `DATABASE_URL` in Vercel - it's only for running the local schema setup script.

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

```text
.
├── src/
│   ├── components/
│   │   ├── dashboard/
│   │   │   ├── preferences/
│   │   │   │   ├── NotificationChannelsSection.astro
│   │   │   │   ├── NotificationPreferencesCard.astro
│   │   │   │   └── ScheduledNotificationsCard.astro
│   │   │   ├── stocks/
│   │   │   │   ├── StockInput.vue
│   │   │   │   └── TrackedStocksPanel.vue
│   │   │   ├── SetupRequiredBanner.astro
│   │   │   └── TestNotifications.astro
│   │   ├── landing/
│   │   │   ├── CTA.astro
│   │   │   ├── Features.astro
│   │   │   ├── Hero.astro
│   │   │   └── SignInCard.astro
│   │   ├── layout/
│   │   │   └── Navigation.astro
│   │   ├── profile/
│   │   │   ├── AccountManagement.astro
│   │   │   ├── DangerZone.astro
│   │   │   └── ProfilePreferences.astro
│   │   ├── PhoneInput.vue
│   │   ├── HCaptcha.astro
│   │   ├── TimezoneMismatchBanner.astro
│   ├── layouts/
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── env.ts
│   │   ├── format.ts
│   │   ├── phone-format.ts
│   │   ├── stocks.ts
│   │   ├── supabase.ts
│   │   ├── timezone-banner.ts
│   │   ├── timezone-select.ts
│   │   ├── timezones.ts
│   │   ├── timezones.test.ts
│   │   ├── hcaptcha-utils.ts
│   │   ├── hcaptcha.ts
│   │   └── users.ts
│   ├── pages/
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   │   ├── email/
│   │   │   │   │   ├── forgot-password.ts
│   │   │   │   │   ├── register.ts
│   │   │   │   │   └── resend-verification.ts
│   │   │   │   ├── sms/
│   │   │   │   │   ├── send-verification.ts
│   │   │   │   │   ├── verify-code.ts
│   │   │   │   │   └── verify-utils.ts
│   │   │   │   ├── delete-account.ts
│   │   │   │   ├── signin.ts
│   │   │   │   └── signout.ts
│   │   │   ├── notifications/
│   │   │   │   ├── email/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── utils.ts
│   │   │   │   ├── sms/
│   │   │   │   │   ├── inbound.ts
│   │   │   │   │   ├── inbound-utils.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── twilio-utils.ts
│   │   │   │   ├── processing.ts
│   │   │   │   ├── scheduled.ts
│   │   │   │   ├── shared.ts
│   │   │   │   └── test.ts
│   │   │   ├── preferences/
│   │   │   │   ├── index.ts
│   │   │   │   └── stocks.ts
│   │   │   ├── profile/
│   │   │   │   └── preferences.ts
│   │   │   ├── form-utils.ts
│   │   │   └── timezone.ts
│   │   ├── auth/
│   │   │   ├── forgot.astro
│   │   │   ├── recover.astro
│   │   │   ├── register.astro
│   │   │   ├── unconfirmed.astro
│   │   │   └── verified.astro
│   │   ├── dashboard.astro
│   │   ├── index.astro
│   │   ├── profile.astro
│   │   └── signin.astro
│   ├── types/
│   │   ├── env.d.ts
│   │   └── libphonenumber-examples.d.ts
│   ├── global.css
│   └── middleware.ts
├── supabase/
│   ├── migrations/
│   │   └── 20250101000000_initial_schema.sql
│   └── config.toml
├── scripts/
│   ├── generate-seed.ts
│   ├── sample-users.json
│   ├── seed-sql.ts
│   ├── us-stocks.json
│   └── users.json
├── tests/
│   ├── pages/
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── register.test.ts
│   │       │   └── signin.test.ts
│   │       ├── notifications/
│   │       │   └── email.test.ts
│   │       ├── preferences/
│   │       │   ├── index.test.ts
│   │       │   └── stocks.test.ts
│   │       └── timezone.test.ts
│   ├── setup.ts
│   └── utils.ts
├── public/
│   └── favicons/
│       ├── android-chrome-192x192.png
│       ├── android-chrome-512x512.png
│       ├── apple-touch-icon.png
│       ├── favicon-16x16.png
│       ├── favicon-32x32.png
│       ├── favicon.ico
│       └── site.webmanifest
├── astro.config.ts
├── biome.jsonc
├── package.json
├── tsconfig.json
├── vercel.json
└── vitest.config.ts
```

## Security Features

- ✅ Row Level Security (RLS) on all database tables
- ✅ CAPTCHA protection for anonymous auth flows (Supabase Auth + hCaptcha)
- ✅ Cron endpoint protected by secret header
- ✅ Phone verification via Twilio Verify API
- ✅ SMS opt-out support (STOP keyword compliance)
- ✅ Service role key never exposed to client
- ✅ Traditional form submissions (no client-side state)

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

### ⚠️ Data Reset Warning

**Resetting the database (`npm run db:reset`) will:**
- Delete all existing data (users, preferences, tracked stocks)
- Re-apply the schema
- Re-seed the database with the updated stock list

This is safe for local development but **do not run this against a production database**. For production updates, you should create a migration that inserts/updates the stocks table.

## License

MIT
