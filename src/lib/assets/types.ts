import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/types";

// --- Universe reconcile ---

/** One normalized stock/etf row from the active-universe listing. */
export interface ActiveTicker {
	symbol: string;
	name: string;
	type: "stock" | "etf";
	/**
	 * Massive's `last_updated_utc` from the list feed (ISO), when present.
	 * Used by reconcile to gate full ticker refreshes; null when the provider
	 * omitted it (name-only refresh still applies).
	 */
	lastUpdatedUtc: string | null;
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
	/** Last Massive `last_updated_utc` we stamped; null until first reconcile bootstrap. */
	reference_updated_utc: string | null;
}

/** Dependencies for `runUniverseReconcile`. */
export interface UniverseReconcileDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	/** Icon-probe seam (new listings + watermark-advanced refreshes). */
	ensureIconChecked?: (deps: EnsureAssetIconCheckedDeps) => Promise<EnsureAssetIconCheckedResult>;
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
	/**
	 * Existing active rows whose Massive `last_updated_utc` advanced — name/type
	 * stamped and icon force-probed.
	 */
	tickersRefreshed: number;
	/** Existing active rows that received a first-time `reference_updated_utc` stamp (no icon probe). */
	referenceWatermarksBootstrapped: number;
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

// --- Icon check (on-add / new-listing probe) ---

/** Dependencies for `ensureAssetIconChecked`. */
export interface EnsureAssetIconCheckedDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	/**
	 * When true, re-probe even if `icon_checked_at` is already set (Massive
	 * reference watermark advanced). Still no-ops for missing/delisted rows.
	 */
	force?: boolean;
	/** Detail-fetch seam, injectable for tests. Defaults to `fetchTickerDetail`. */
	getTickerDetail?: (symbol: string) => Promise<TickerDetail>;
}

/** Result of a single-symbol icon probe. */
export interface EnsureAssetIconCheckedResult {
	/** True when this call performed a definitive Massive check + DB write. */
	probed: boolean;
	/** Stored icon URL after the call (null when none / skipped / failed). */
	iconUrl: string | null;
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
