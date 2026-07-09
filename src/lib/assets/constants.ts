// --- Universe reconcile tuning ---

/**
 * Max new-listing warmup backfills enqueued per reconcile run. Warmups fan out into
 * Massive bars calls via the vendor-backfill queue (5/min free-tier budget), so an
 * unusually large new-listing delta — e.g. the first run after a universe-source
 * switch — must not translate into an unbounded SQS backfill storm. Skipped symbols
 * are logged and simply never warm; nothing user-facing blocks on warmup.
 */
export const MAX_WARMUP_ENQUEUES_PER_RUN = 25;

// --- Icon backfill tuning ---

/**
 * Max never-checked symbols the nightly icon backfill probes per run. Each probe is one
 * Finnhub `/stock/profile2` call on the 55/min budget (~4 minutes at 200), sized to
 * leave the asset-maintenance Lambda ample headroom. The ~11k-symbol backlog drains in
 * ~2 months of nightly runs; icons are cosmetic and nothing user-facing blocks on them.
 */
export const ICON_BACKFILL_NIGHTLY_CAP = 200;

/** Bounded concurrency for icon detail fetches (calls queue on the 55/min limiter anyway). */
export const ICON_BACKFILL_CONCURRENCY = 4;

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
 * Max tracked symbols the nightly prediction-market discovery drip processes per run.
 * Each symbol may hit Polymarket search + Kalshi series markets + optional Grok alias
 * enrich; sized like warmup enqueues so the asset-maintenance Lambda keeps headroom.
 */
export const PM_DISCOVERY_NIGHTLY_CAP = 25;

/**
 * Milliseconds in the notification_log dedupe window. A successful
 * `type='delisting'` row within this window for a given user suppresses a
 * second email, even if the sweep re-runs due to a crash or retry. The
 * window is wider than the cron interval so a crash-across-midnight case
 * can't produce duplicate emails.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
