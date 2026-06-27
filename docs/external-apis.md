# External APIs

## Massive

(formerly Polygon.io.) Paid $29/mo plan: unlimited requests, recommended <100 req/s. API at `api.massive.com`; legacy `api.polygon.io` still works. Always refer to as "Massive" in code/comments.

Sole source of:

- Live snapshot quotes
- Prev-day bars (snapshot fallback)
- Asset reference universe used to seed `scripts/data/us-assets.json`

Approx universe size: ~5,257 CS + ~378 ADRC = ~5,635 stocks; ~5,021 ETFs.

## Finnhub

Free tier only. Used for:

- **Earnings calendar** (`/calendar/earnings` via `fetchEarnings` in `src/lib/vendors/finnhub/earnings.ts`, because Massive's earnings endpoint isn't entitled on our plan).
- **Analyst recommendations + insider transactions** (persisted during the daily asset-events ingest; read at send time from `asset_analyst_consensus` / `asset_insider_transactions`).

**Never used for live quotes** — the quote path is Massive-only, falling back to prev-day bars for snapshot misses.

## Vendor fault tolerance

Scheduled notifications treat third-party calls in three tiers. Implementation lives in `src/lib/resilience/optional-vendors.ts`, `src/lib/vendors/fetch.ts`, and `src/lib/schedule/retry-delays.ts`.

### Critical (must succeed or retry with backoff)

Failures log `category: "vendor_retry_exhausted"` and feed CloudWatch vendor-retry alarms.

| Vendor | Routes / use |
| --- | --- |
| Massive | Market status, snapshot quotes, prev-day bars, daily OHLCV (`compute-daily-stats`) |
| Finnhub | Earnings calendar (`/calendar/earnings`) in the daily asset-events ingest |
| SES / Twilio | Outbound email/SMS delivery via `scheduled_notifications` claim + exponential `next_retry_at` |

### Optional (degrade — omit section, do not block send)

Failures log `category: "optional_vendor_degraded"` at warn. In-process circuit opens after repeated failures (15 min). Per-user time budgets cap slow optional work.

| Vendor | Routes / use |
| --- | --- |
| Massive | Company news (`/v2/reference/news`), top movers, intraday/daily sparklines, logo fetch |
| Finnhub | Analyst recommendations, insider transactions (daily ingest; omit section when stale/missing at send time) |
| xAI Grok | Daily digest news/rumors, price-alert summaries |

### Gating rules (daily digest)

- Company news and Grok news context run only when **email is enabled**, the user opted into **news email**, and **Grok quota** allows it.
- SMS-only users never call Massive company-news for digest context.
- Optional news uses an **8s per-user budget** and a **8s per-request** timeout (not the 25s critical default).

### Delivery retries

`scheduled_notifications.next_retry_at` gates `claim_scheduled_notification`. Backoff after failure: 5m → 15m → 30m → 60m (cap). `daily_digest_next_send_at` advances only after all enabled channels for the slot are **sent** or **retries exhausted**.
