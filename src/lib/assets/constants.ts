// --- Universe reconcile tuning ---

/**
 * Default per-run enrichment cap — candidates beyond this defer to subsequent runs.
 *
 * Sized for Massive's free-tier budget (5 calls/min, `MASSIVE_MAX_CALLS_PER_MINUTE`): 25
 * detail calls ≈ 5 minutes of the nightly AssetMaintenance run. The backlog drains over
 * nights; enrichment is idempotent and nothing user-facing blocks on it.
 */
export const DEFAULT_ENRICHMENT_CAP = 25;

/** Default bounded concurrency for the per-symbol detail fetch (calls queue on the 5/min limiter anyway). */
export const DEFAULT_ENRICHMENT_CONCURRENCY = 2;

/** Upsert/flag chunk size — keeps `.in()` filter URLs under practical length limits. */
export const CHUNK_SIZE = 500;

/**
 * Absolute floor on the fetched active-set size below which step 3 skips delist-flagging as a
 * suspected silent truncation. The real US stock+ETF active universe is ~11k; a truncated fetch
 * degrades to one or a few 1000-row pages. Deliberately an ABSOLUTE floor, NOT a fraction of the
 * stored active count — that count is inflated by the very backlog this job exists to drain.
 */
export const MIN_PLAUSIBLE_ACTIVE_UNIVERSE = 5000;

// --- Delisting sweep ---

/**
 * Max tracked symbols reference-checked per nightly sweep. Each check is one Massive call,
 * so the cap bounds the sweep at ~3 minutes of the free-tier 5/min budget. The sweep rotates
 * deterministically through the sorted symbol list night over night, so every symbol is
 * still checked within ceil(n / cap) nights — at household scale (≲30 tracked symbols),
 * every 1-2 nights.
 */
export const DELISTING_SWEEP_MAX_SYMBOLS_PER_RUN = 15;

/**
 * Milliseconds in the notification_log dedupe window. A successful
 * `type='delisting'` row within this window for a given user suppresses a
 * second email, even if the sweep re-runs due to a crash or retry. The
 * window is wider than the cron interval so a crash-across-midnight case
 * can't produce duplicate emails.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
