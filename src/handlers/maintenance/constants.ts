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

/** Delisting sweep: all tracked symbols at bounded concurrency, plus notification writes. */
export const SWEEP_MIN_REMAINING_MS = 300_000;

/** Icon backfill: up to 500 Massive branding calls at concurrency 10 (~1–2 min typical). */
export const ICON_BACKFILL_MIN_REMAINING_MS = 120_000;

/**
 * Prediction-market discovery drip: up to 25 tracked symbols (Poly search + Kalshi
 * series fetches + optional Grok). Soft-fail vendors; still needs wall-clock headroom.
 */
export const PM_DISCOVERY_MIN_REMAINING_MS = 240_000;

/**
 * Prediction-market snapshot refresh: re-fetch all active stored events.
 * Soft-fails per event; needs headroom for Poly/Kalshi rate limits.
 */
export const PM_REFRESH_MIN_REMAINING_MS = 300_000;
