/**
 * Per-step minimum-remaining-time budgets for the asset-maintenance Lambda.
 *
 * Rate-limiter waits are silent (no log output while `acquire()` sleeps), so a budget
 * overrun would otherwise present as an opaque Lambda timeout with a clean log tail —
 * the 2026-07-07 incident shape. Each nightly step checks
 * `context.getRemainingTimeInMillis()` against its budget and SKIPS WITH AN ERROR LOG
 * (pages via ErrorLogAlarm) instead of dying silently mid-step. Budgets are sized from
 * worst-case vendor-call counts: Massive at 5/min (~12s/call), Finnhub at 55/min.
 */

/** Universe reconcile: 1 Finnhub call + ~28 chunked DB round-trips over ~27k rows. */
export const RECONCILE_MIN_REMAINING_MS = 240_000;

/** Delisting sweep: up to 15 Massive confirm calls ≈ 180s of 5/min budget + notify writes. */
export const SWEEP_MIN_REMAINING_MS = 300_000;

/** Icon backfill: up to 200 Finnhub calls ≈ 220s of 55/min budget. */
export const ICON_BACKFILL_MIN_REMAINING_MS = 300_000;

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

/**
 * ISO weekday (1 = Monday … 7 = Sunday) on which the full universe reconcile runs.
 * Sunday: the market is closed, the 00:00 UTC schedule tick is quiet, and a full week
 * of listing changes lands before Monday's sessions. Delisting safety does NOT depend
 * on this cadence — the confirm-based sweep covers tracked symbols nightly.
 */
export const RECONCILE_UTC_WEEKDAY = 7;
