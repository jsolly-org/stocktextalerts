# Stock Price Notifications Design

## Goal

Add real-time stock pricing to digest email and SMS notifications. Each stock in the notification will show its current price and daily percent change alongside the existing symbol and company name.

## Decisions

- **API:** Finnhub free tier (`/quote` for prices, `/stock/market-status` for market hours)
- **Price data:** Current price + daily change percent per stock
- **SMS truncation:** Remove the 160-character limit; allow Twilio multi-segment SMS
- **Query optimization:** Batch-deduplicated fetching — collect all unique symbols across users due in a cron cycle, fetch once per symbol, distribute via in-memory map
- **Error handling:** Per-symbol failures fall back to current no-price format (symbol + company name only); log errors via structured logger
- **Market hours disclaimer:** Use Finnhub `/stock/market-status?exchange=US` once per cron cycle. If market is closed, append "Prices as of last market close." to both email and SMS
- **Env var:** `FINNHUB_API_KEY` — required, validated in middleware like all other keys

## Data Flow

```
Cron fires (/api/schedule, every 15 min)
  ↓
Query users where next_send_at <= now (existing)
  ↓
Collect all unique stock symbols across those users
  ↓
Fetch market status from Finnhub (1 call)
  ↓
Fetch price for each unique symbol from Finnhub (/quote)
  → Returns Map<string, { price: number, changePercent: number } | null>
  → null = fetch failed or price was 0 (delisted/invalid)
  ↓
Pass price map + market status into per-user processing
  ↓
Format email/SMS with price data (or fall back to no-price format)
  ↓
Send notifications (existing)
```

## Notification Formats

### SMS

With prices (market open):

```
AAPL - Apple Inc. — $187.42 (+1.23%)
MSFT - Microsoft Corporation — $412.10 (-0.31%)

Reply STOP to opt out.
```

With prices (market closed):

```
AAPL - Apple Inc. — $187.42 (+1.23%)
MSFT - Microsoft Corporation — $412.10 (-0.31%)

Prices as of last market close. Reply STOP to opt out.
```

With price fetch failure (per-stock fallback):

```
AAPL - Apple Inc.
MSFT - Microsoft Corporation — $412.10 (-0.31%)

Reply STOP to opt out.
```

### Email

- Same data as SMS but with HTML formatting
- Green/red coloring for positive/negative daily change
- "Prices as of last market close." shown as a subtitle or footnote when market is closed
- Graceful per-stock fallback to symbol + company name when price unavailable

## New Files

- `src/lib/stocks/price-fetcher.ts` — Finnhub API client
  - `fetchStockPrices(symbols: string[]): Promise<Map<string, StockPrice | null>>` — fetches `/quote` for each symbol
  - `fetchMarketStatus(): Promise<boolean>` — calls `/stock/market-status?exchange=US`, returns `true` if market is open
  - `StockPrice` type: `{ price: number, changePercent: number }`
  - Treats price of `0` as unavailable (returns `null`)

## Modified Files

- `src/lib/schedule/run.ts` — After querying users, collect unique symbols, call `fetchStockPrices()` and `fetchMarketStatus()`, pass results into per-user processing
- `src/lib/schedule/run-user.ts` — Accept price map and market status as parameters, thread through to email/SMS formatting
- `src/lib/messaging/email/utils.ts` — Update `formatEmailMessage()` to display price + change with green/red coloring; show market-closed disclaimer when applicable; fall back to no-price format per stock
- `src/lib/messaging/email/delivery.ts` — Thread price map and market status through to formatting
- `src/lib/messaging/sms/delivery.ts` — Update `processSmsUpdate()` to include price + change in full format; remove 160-character truncation; add market-closed disclaimer when applicable; fall back to no-price format per stock
- `src/middleware.ts` — Add `FINNHUB_API_KEY` to required env var validation

## Error Handling

- **Per-symbol API failure:** Return `null` in the price map; notification falls back to no-price format for that stock. Log the error with structured logger.
- **Price is 0:** Treat as unavailable (delisted/invalid symbol). Return `null`.
- **Market status API failure:** Default to showing the disclaimer (assume market closed). Safer to over-inform than under-inform.
- **Rate limiting:** Finnhub free tier allows 60 calls/min. With max 10 stocks/user and batch deduplication, this is not a concern at current scale.

## Not In Scope

- Storing historical price data
- Price change alerts/thresholds
- Pre-market/after-hours pricing
- Caching prices across cron cycles
