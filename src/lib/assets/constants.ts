// --- Universe reconcile tuning ---

/** Default per-run enrichment cap — candidates beyond this defer to subsequent runs. */
export const DEFAULT_ENRICHMENT_CAP = 500;

/** Default bounded concurrency for the per-symbol detail fetch. */
export const DEFAULT_ENRICHMENT_CONCURRENCY = 20;

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
 * Milliseconds in the notification_log dedupe window. A successful
 * `type='delisting'` row within this window for a given user suppresses a
 * second email, even if the sweep re-runs due to a crash or retry. The
 * window is wider than the cron interval so a crash-across-midnight case
 * can't produce duplicate emails.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
