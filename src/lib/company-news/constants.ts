/**
 * Per-user total budget for Finnhub company-news fetches in one digest run. Bounds
 * total news latency via `withOptionalVendorBudget`; the underlying `finnhubFetch`
 * keeps its own per-attempt timeout/retry policy.
 */
export const COMPANY_NEWS_USER_BUDGET_MS = 8_000;

/** Max articles kept per symbol — bounds digest size and Grok context length. */
export const COMPANY_NEWS_MAX_ARTICLES = 10;
