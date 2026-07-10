import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/types";

// --- Universe reconcile ---

/** One normalized stock/etf row from the active-universe listing. */
export interface ActiveTicker {
	symbol: string;
	name: string;
	type: "stock" | "etf";
}

/** The fetched active US listing: the typed subset we store, plus every active symbol. */
export interface ActiveUniverse {
	tickers: ActiveTicker[];
	/** Every symbol returned by the configured active Massive type pages. */
	allActiveSymbols: ReadonlySet<string>;
}

/**
 * Detail-fetch result returned by the logo enrichment seam. The union is
 * load-bearing: `ok: true` is a DEFINITIVE answer (stamps `icon_checked_at`,
 * permanently), `ok: false` is transient (row stays unchecked and retries) — a
 * non-definitive result cannot carry an icon by construction.
 */
export type TickerDetail = { ok: true; iconUrl: string | null } | { ok: false };

/** A stored `assets` row, the subset reconcile reads for classification. */
export interface StoredAsset {
	symbol: string;
	name: string;
	delisted_at: string | null;
}

/** Dependencies for `runUniverseReconcile`. */
export interface UniverseReconcileDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
}

/** Summary counters returned by `runUniverseReconcile`. */
export interface UniverseReconcileResult {
	/** Size of the de-duplicated stock/etf active set. */
	activeTickersFetched: number;
	/** Size of the full active symbol superset from the configured Massive type pages. */
	allActiveSymbols: number;
	/** Active symbols that did not previously exist in `assets`, inserted this run. */
	newListingsInserted: number;
	/** Existing active rows whose stored name was refreshed from Massive. */
	namesUpdated: number;
	/** Insert chunks that failed to write (partial coverage — surfaced in the summary). */
	insertChunksFailed: number;
	/** Previously-flagged rows set back to `delisted_at = null` (reappeared). */
	delistedCleared: number;
	/** Untracked stored symbols absent from the active superset, newly flagged delisted. */
	untrackedDelistedFlagged: number;
	/** True when step 3 skipped flagging because the active set was implausibly small. */
	delistFlagSkippedShrunkActive: boolean;
	/** New symbols successfully enqueued for warmup. */
	warmupEnqueued: number;
	/** New symbols whose warmup enqueue returned false. */
	warmupEnqueueFailed: number;
	/** True when step 1 returned an empty set — the run aborted before any mutation. */
	providerFetchFailed: boolean;
}

// --- Icon backfill ---

/** Dependencies for `runIconBackfill`. */
export interface IconBackfillDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	/** Per-run check cap. Defaults to `ICON_BACKFILL_NIGHTLY_CAP`. */
	cap?: number;
	/** Bounded detail-fetch concurrency. Defaults to `ICON_BACKFILL_CONCURRENCY`. */
	concurrency?: number;
	/** Detail-fetch seam, injectable for tests. Defaults to `fetchTickerDetail`. */
	getTickerDetail?: (symbol: string) => Promise<TickerDetail>;
}

/** Summary counters returned by `runIconBackfill`. */
export interface IconBackfillResult {
	/** Unchecked candidates remaining in the table before this run. */
	candidatesRemaining: number;
	/** Symbols definitively checked this run (icon or confirmed none). */
	checked: number;
	/** Checked symbols that yielded an icon URL. */
	iconsFound: number;
	/** Detail fetches that failed transport — left unchecked for a later run. */
	fetchFailed: number;
	/** DB writes that failed — left unchecked for a later run. */
	writeFailed: number;
}

// --- Delisting sweep ---

/** Dependencies for `runDelistingSweep`. */
export interface DelistingSweepDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: EmailSender;
}

/** Summary counters returned by `runDelistingSweep`. */
export interface DelistingSweepResult {
	/** Tracked, non-flagged symbols reference-checked this run. */
	symbolsChecked: number;
	newlyDetectedDelistings: number;
	reprocessedDelistings: number;
	/** Users who received at least one successful delivery on any channel. */
	usersNotified: number;
	emailsDelivered: number;
	emailsSkippedOptOut: number;
	emailsFailed: number;
	userAssetRowsDeleted: number;
	providerErrors: number;
}
