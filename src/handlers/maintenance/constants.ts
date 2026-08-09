/**
 * Per-step minimum-remaining-time budgets for the asset-maintenance Lambda.
 *
 * Vendor retries, bounded Massive concurrency, and residual Finnhub pacing can consume
 * substantial runtime. Each nightly step checks `context.getRemainingTimeInMillis()`
 * against its budget and SKIPS WITH AN ERROR LOG (pages via ErrorLogAlarm) instead of
 * dying silently mid-step.
 */

/** Universe reconcile: Massive reference pagination + chunked DB round-trips. */
export const RECONCILE_MIN_REMAINING_MS = 180_000;

/** Delisting sweep: tracked symbols at bounded concurrency, plus notification writes. */
export const SWEEP_MIN_REMAINING_MS = 60_000;

/**
 * Prediction-market steps run last (after delisting + reconcile). Entry gates
 * only need enough headroom for the in-loop abort floor (~120s) plus a little
 * useful work — they no longer reserve time for later integrity steps.
 */
export const PM_DISCOVERY_MIN_REMAINING_MS = 150_000;

/** Active matched-event snapshot refresh (Poly/Kalshi); in-loop abort at ~120s. */
export const PM_REFRESH_MIN_REMAINING_MS = 150_000;

/** Next-session Polymarket daily up/down probe for every tracked symbol. */
export const PM_DIRECTION_PROBE_MIN_REMAINING_MS = 150_000;

/**
 * Finnhub analyst + insider enrichment over content-tracked symbols (serial,
 * ~2 calls/symbol at 55/min). Soft-fail; gated so it cannot starve SEC/short/PM.
 */
export const ENRICHMENT_MIN_REMAINING_MS = 120_000;

/**
 * SEC EDGAR filings ingest: company tickers map + one submissions poll per
 * distinct content-tracked CIK (polite delay). Soft-fail vendor; remaining-time gate.
 */
export const SEC_FILINGS_MIN_REMAINING_MS = 120_000;

/** Short interest daily Asset Events facet step budget (Massive bulk + ticker details). */
export const SHORT_INTEREST_MIN_REMAINING_MS = 120_000;
