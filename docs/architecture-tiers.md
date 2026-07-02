# Architecture: Vercel vs Lambda tiers

StockTextAlerts runs on two compute tiers. Shared business logic lives in `src/lib/`; each tier owns thin entry points only.

## Decision rule

| Trigger | Tier | Entry point |
| --- | --- | --- |
| User/browser request (session cookies, dashboard JSON, webhooks) | **Vercel** (Astro SSR) | `src/pages/api/*` |
| Scheduled cron, SQS queue, signed internal HTTP | **AWS Lambda** | `src/handlers/*.ts` |
| Domain logic used by either tier | **Shared** | `src/lib/*` |

When adding a feature, ask: *does this need a browser session or a stable public URL on the app domain?* If yes → Vercel route. *Is it batch/async/cron with no user context?* If yes → Lambda handler. Put reusable logic in `src/lib/`, not in the entry point.

## Vercel (`src/pages/api/`)

**Responsibilities:**

- Cookie/session auth via `createUserService()` and Supabase RLS
- Dashboard CRUD (assets, notification preferences, profile)
- Public auth flows (sign-in, register, password reset) — mostly HTML redirects
- Inbound webhooks (Twilio SMS, Telegram bot) — stable URLs on the app domain; CSRF middleware exempts these paths
- User-initiated Massive fetches (prices, sparklines, logo proxy with CDN cache)

**Client helpers:** browser-only `fetch()` wrappers live in `src/lib/client/` (not in route files).

**Server domain logic:** feature modules under `src/lib/` (e.g. `notification-preferences/`, `market-data/`, `auth/`). Routes stay thin: auth, validation, HTTP status codes, logging.

## Lambda (`src/handlers/`)

Seven deployed functions (see `aws/template.yaml`):

| Handler | Trigger | Role |
| --- | --- | --- |
| `schedule` | Every 1 minute | Deliver staged notifications; run full schedule pipeline; purge expired short URLs and dispatch keys |
| `asset-maintenance` | Daily 00:00 UTC | Asset events ingest, universe reconcile, delisting sweep, Finnhub enrichment |
| `compute-daily-stats` | Weekdays 22:00 UTC | Compute ADV/ATR; cache daily closes |
| `vendor-backfill` | SQS | Retry failed vendor work (asset events, daily closes, price history) |
| `email-dispatch` | Lambda Function URL (HMAC POST) | Centralized SES send with idempotency |
| `live-provider-check` | Weekdays 16:00 UTC + post-deploy | Live Massive/Finnhub/Telegram smoke test |
| `backup-user-settings` | 5× daily UTC | Export user settings snapshot to S3 |

Handlers are thin wrappers: `runLambda()` for SSM secret hydration, then call into `src/lib/`. They use the admin Supabase client (no browser cookies).

## Bridge patterns

### Vercel → SQS → Lambda

Example: `POST /api/assets/update` enqueues symbol warmup via `enqueueNewSymbolWarmup()`; `vendor-backfill` Lambda processes the queue.

Use this when user action should trigger async work that can run outside the request lifecycle.

### Vercel → Lambda Function URL (transactional email)

Registration admin alerts and user approval emails call `sendAppTransactionalEmail()` in `src/lib/messaging/email/dispatch-client.ts`, which POSTs to the `email-dispatch` Lambda with HMAC auth.

Vercel never holds bulk SES credentials for notification delivery.

### Lambda bulk email (schedule / maintenance)

Scheduled notification delivery and delisting alerts call `createEmailSender()` directly in the Lambda runtime (SES via execution role). This path is high-volume and does not go through `email-dispatch`.

## Shared lib layout (notification preferences example)

- `src/lib/messaging/notification-prefs.ts` — canonical pref model and defaults
- `src/lib/notification-preferences/channels.ts` — form ↔ `notification_preferences` table
- `src/lib/notification-preferences/update-payload.ts` — `users`-table schedule fields and `*_next_send_at`
- `src/lib/client/notification-preferences.ts` — browser fetch wrapper for the dashboard

The schedule Lambda **reads** the DB state that Vercel routes **write**; both use the same schedule math in `src/lib/time/schedule/`.

## Non-goals

- Do not add a generic `src/lib/api/` catch-all. Name modules by domain (`notification-preferences/`, `client/`, etc.).
- Do not move webhooks or UI Massive calls to Lambda without a concrete driver (latency, isolation, cost).
- Do not move cron/batch work to Vercel — no durable scheduler on the web tier.
