/** Shared retry/timeout policy and base URLs for third-party market-data HTTP. */

/** Base URL for Finnhub REST API calls. */
export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/** Base URL for Massive REST API calls. */
export const MASSIVE_BASE_URL = "https://api.massive.com";

/** Base URL for Polymarket Gamma (public market discovery / odds). */
export const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

/** Base URL for Kalshi public Trade API (market data, no auth). */
export const KALSHI_TRADE_API_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

/**
 * Proactive per-process Polymarket call budget. Gamma limits are per-10s and
 * generous (hundreds); 60/min keeps us polite and matches the Finnhub shape.
 */
export const POLYMARKET_MAX_CALLS_PER_MINUTE = 60;

/**
 * Proactive per-process Kalshi call budget. Public REST is unauthenticated;
 * 60/min is plenty for a curated digest strip.
 */
export const KALSHI_MAX_CALLS_PER_MINUTE = 60;

/** User-Agent for public prediction-market APIs (some CDNs 403 bare clients). */
export const PREDICTION_MARKET_USER_AGENT = "StockTextAlerts/1.0 (+https://stocktextalerts.com)";

/**
 * Proactive per-process Finnhub call budget. Free tier allows 60/min per key; 55 leaves
 * headroom for clock skew. Per-process, so the scheduler Lambda, the Astro web runtime, and
 * the live-check each get their own window — the 429/Retry-After handling in `finnhubFetch`
 * is the backstop if they collide on the shared key.
 */
export const FINNHUB_MAX_CALLS_PER_MINUTE = 55;

/**
 * Proactive per-process Massive call budget. The free tier allows exactly 5 requests per
 * rolling minute (verified empirically against the downgraded key, 2026-07-05: 5×200 then
 * hard 429s, window rolls after ~a minute). Per-process like the Finnhub budget;
 * cross-process collisions (scheduler vs nightly maintenance) fall back to the
 * 429/Retry-After retry handling in `marketDataFetch`.
 */
export const MASSIVE_MAX_CALLS_PER_MINUTE = 5;

/**
 * Warn when a single Massive limiter `acquire()` wait exceeds this. Normal 5/min
 * pacing waits ~12s (a few queued callers stack to ~30-40s); a wait past this
 * threshold means real contention — a job overrunning its call budget or
 * cross-process collision on the shared key — and must leave a log trail before
 * it turns into a silent Lambda timeout.
 */
export const MASSIVE_LIMITER_WAIT_WARN_MS = 60_000;

export const VENDOR_FETCH_MAX_RETRIES = 3;
export const VENDOR_FETCH_RETRY_DELAY_MS = 2_000;
/** Per-attempt abort; Finnhub earnings/insider can exceed 10s under load. */
export const VENDOR_FETCH_REQUEST_TIMEOUT_MS = 25_000;

/** Consecutive failures before an optional vendor circuit opens. */
export const OPTIONAL_VENDOR_CIRCUIT_FAILURE_THRESHOLD = 2;

/** How long an optional vendor circuit stays open after tripping. */
export const OPTIONAL_VENDOR_CIRCUIT_OPEN_MS = 15 * 60 * 1000;
