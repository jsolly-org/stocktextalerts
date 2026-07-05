/** Shared retry/timeout policy and base URLs for third-party market-data HTTP. */

/** Base URL for Finnhub REST API calls. */
export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/** Base URL for Massive REST API calls. */
export const MASSIVE_BASE_URL = "https://api.massive.com";

/**
 * Proactive per-process Finnhub call budget. Free tier allows 60/min per key; 55 leaves
 * headroom for clock skew. Per-process, so the scheduler Lambda, the Astro web runtime, and
 * the live-check each get their own window — the 429/Retry-After handling in `finnhubFetch`
 * is the backstop if they collide on the shared key.
 */
export const FINNHUB_MAX_CALLS_PER_MINUTE = 55;

export const VENDOR_FETCH_MAX_RETRIES = 3;
export const VENDOR_FETCH_RETRY_DELAY_MS = 2_000;
/** Per-attempt abort; Finnhub earnings/insider can exceed 10s under load. */
export const VENDOR_FETCH_REQUEST_TIMEOUT_MS = 25_000;

/** Consecutive failures before an optional vendor circuit opens. */
export const OPTIONAL_VENDOR_CIRCUIT_FAILURE_THRESHOLD = 2;

/** How long an optional vendor circuit stays open after tripping. */
export const OPTIONAL_VENDOR_CIRCUIT_OPEN_MS = 15 * 60 * 1000;
