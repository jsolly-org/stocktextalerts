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

- **Earnings calendar** (`/calendar/earnings` via `fetchFinnhubEarnings` in `src/lib/providers/massive.ts`, because Massive's earnings endpoint isn't entitled on our plan).
- **"Extras" bundle** (analyst recommendations + insider transactions via `fetchFinnhubExtras` in `src/lib/providers/finnhub.ts`).

**Never used for live quotes** — the quote path is Massive-only, falling back to prev-day bars for snapshot misses.
