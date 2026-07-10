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

/**
 * Prediction-market discovery: all unchecked tracked symbols (Poly + Kalshi +
 * optional Grok). Soft-fail vendors; wall-clock headroom for the step gate +
 * in-loop remaining-time abort.
 */
export const PM_DISCOVERY_MIN_REMAINING_MS = 240_000;

/**
 * Prediction-market snapshot refresh: all active matched events. Soft-fails per
 * event; needs headroom for Poly/Kalshi rate limits + in-loop abort.
 */
export const PM_REFRESH_MIN_REMAINING_MS = 300_000;
