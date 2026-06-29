/** Per-user total budget for Massive company-news fetches in one digest run. */
export const COMPANY_NEWS_USER_BUDGET_MS = 8_000;

/** Shorter per-request timeout for optional company-news (critical paths use fetch default). */
export const COMPANY_NEWS_REQUEST_TIMEOUT_MS = 8_000;
