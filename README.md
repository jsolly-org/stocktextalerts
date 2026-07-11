# StockTextAlerts

A securities notification app that sends scheduled **email** and **Telegram** updates (market price notifications, daily digests, asset events) and optional price alerts for tracked US stocks and ETFs.

Built with Astro 7 (SSR) on Vercel, Supabase (Auth + PostgreSQL), AWS Lambda/SAM for notification crons, AWS SES for email, and the Telegram Bot API (including candlestick charts).

## Features

- **Asset tracking** — Search and track US stocks and ETFs (up to 10)
- **Email notifications** — AWS SES via Lambda (local Mailpit in development)
- **Telegram notifications** — Bot API delivery with optional candlestick charts
- **Asset price alerts** — Optional smart alerts for tracked stocks (not ETFs) during US market hours, with Significant/Extreme sensitivity (capped at one alert per symbol per US trading day)
- **Timezone support** — Browser-detected timezones with user overrides
- **Market notifications** — Up to 8 delivery times for scheduled price updates (4:30 AM–7:30 PM ET on market-open days), by email and/or Telegram
- **Daily digest** — Once-daily prices plus optional News/Rumors add-ons (email and Telegram)
- **Asset events** — Earnings/dividends/splits/IPOs plus optional insider trades and analyst consensus (per-channel toggles)
- **Format preferences** — Live email/Telegram previews and optional sparklines

## Architecture

![StockTextAlerts architecture diagram](docs/architecture.drawio.svg)

Two compute tiers share domain logic in `src/lib/`: Vercel (Astro SSR) owns browser sessions, dashboard CRUD, and inbound webhooks, while AWS Lambda owns the notification crons and async vendor work. The SVG embeds the draw.io diagram XML, so it can be edited directly in [draw.io](https://www.drawio.com/). Details on when code belongs on which tier: [docs/architecture-tiers.md](docs/architecture-tiers.md).

## Tech stack

- **Framework**: Astro 7 with SSR (Vite 8 / Rolldown)
- **UI**: Vue 3 + Tailwind CSS 4
- **Database**: Supabase (PostgreSQL + Auth)
- **Market data**: Massive (quotes, bars, calendar, movers, universe, logos, news, corporate actions, delistings) + Finnhub (earnings, recommendations, insider)
- **AI summaries**: xAI/Grok (optional News/Rumors)
- **Email**: AWS SES (Lambda execution role)
- **Telegram**: Bot API + `@resvg/resvg-wasm` charts on Lambda
- **Hosting**: Vercel (web) + AWS Lambda (crons via SAM)
- **Lint / test**: Biome, Vitest, Playwright

### Historical note: SMS removed

Delivery used to include **SMS via Twilio**. That channel was removed in July 2026 (email + Telegram only). If you want to restore SMS, start from these PRs and the schema migration they land:

| PR | What it did |
| --- | --- |
| [#550](https://github.com/birthmilk/stocktextalerts/pull/550) | End-to-end removal: `messaging/sms/`, Twilio Verify/webhook, short URLs, dashboard/SMS prefs, `NOTIFICATION_OPTION_MATRIX`, migration `20260705212830_remove_sms_channel.sql` (`delivery_method` → `email` \| `telegram`) |
| [#551](https://github.com/birthmilk/stocktextalerts/pull/551) | Follow-up infra: drop Twilio SSM env vars from `aws/template.yaml` (then `deploy:infra`) |

Re-adding SMS means reversing that surface (schema + matrix + messaging module + Twilio secrets/IAM + UI), not flipping a feature flag.

## Prerequisites

- Node.js (see [`.nvmrc`](.nvmrc))
- Podman (recommended) or Docker for local Supabase
- Accounts you will need for a full stack: Supabase, Massive, Finnhub, Vercel, AWS (SAM CLI), Telegram BotFather; xAI optional

## Local development

```bash
git clone <repo-url>
cd stocktextalerts
cp env.example .env.local
# Replace every <placeholder> in .env.local (see comments in that file)
npm ci
npm run db:start
npm run db:reset   # migrations + seed + generated types
npm run dev        # http://localhost:4321
```

Mailpit (local email UI): <http://127.0.0.1:54324>. Ports and Astro 7 lock notes: [docs/tooling-setup.md](docs/tooling-setup.md).

**Seed users:** copy `scripts/data/sample-users.json` → `scripts/data/users.json` (gitignored) before `db:reset` if you want seeded logins. Passwords come from `DEFAULT_PASSWORD` in `.env.local`.

### Environment variables

[`env.example`](env.example) is the source of truth for names and which runtime needs them. Values use the `<placeholder>` convention — replace them; do not commit `.env.local`.

| Runtime | What belongs there |
| --- | --- |
| **Local `.env.local`** | Full set for dev/tests + optional SAM injectables |
| **Vercel** | Supabase keys, `UNSUBSCRIBE_TOKEN_SECRET`, `MASSIVE_API_KEY`, `ADMIN_EMAILS`, email-dispatch URL/secret, all four `TELEGRAM_*` vars |
| **Lambda** | Secrets via SSM under `SSM_PREFIX` (default `/stocktextalerts`); see [docs/self-hosting.md](docs/self-hosting.md) |
| **GitHub `Production` env** | `DATABASE_URL_PROD`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `PRODUCTION_SITE_URL` |

Do **not** put `FINNHUB_API_KEY`, `XAI_API_KEY`, `EMAIL_FROM`, `DATABASE_URL`, or `DEFAULT_PASSWORD` on Vercel.

## Testing

GitHub Actions runs the full battery on PRs and `main`. Local DB-backed tests are **opt-in**:

```bash
npm run test:local      # Vitest + preflight
npm run test:e2e:local  # Playwright + preflight
```

Details: [tests/README.md](tests/README.md). Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Production / self-hosting

Bootstrapping a new environment is mostly **manual** (accounts, SES, SSM secrets, Telegram webhook, first `deploy:infra`). After that, merges to `main` deploy web (Vercel Git) and Lambda code + migrations (GitHub Actions) in parallel with the post-merge CI canary.

Full checklist, env matrix, and fork injectables (`SES_IDENTITY_DOMAIN`, `SSM_PREFIX`, `ALERT_TOPIC_SSM_PARAM`, …): **[docs/self-hosting.md](docs/self-hosting.md)**.

CI and branch-protection details for this repo: [docs/github-ci.md](docs/github-ci.md).

### Lambda overview

- **Schedule** (every minute) — price alerts, scheduled market notifications, asset events, daily digest → email/Telegram
- **Asset maintenance** (daily) — Finnhub + Massive ingest, universe reconcile, delisting confirms
- **Compute daily stats** (weekdays) — closes for watchlist sparklines

Massive Starter quotes may be delayed up to 15 minutes; the one-minute cadence is for delivery precision, not real-time freshness.

Infra/template changes still need a manual `npm run deploy:infra` (admin AWS credentials).

## Project structure

- `src/components/` — Astro + Vue UI
- `src/pages/` — Routes and API endpoints
- `src/lib/` — Server logic (auth, db, vendors, notification pipelines, messaging)
- `src/handlers/` — AWS Lambda entry points
- `supabase/` — Local config + migrations
- `aws/` — SAM template and deploy scripts
- `tests/` — Vitest + Playwright
- `docs/` — Tooling, CI, self-hosting, [database schema](docs/database-schema.md)

## Security

- RLS on database tables; service role never exposed to the client
- Telegram webhook authenticated via `TELEGRAM_WEBHOOK_SECRET`
- Email unsubscribe links HMAC-signed with `UNSUBSCRIBE_TOKEN_SECRET`
- Rate limits on password/email change and account deletion (see `env.example`)

## License

[MIT](LICENSE)
