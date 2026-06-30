import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";

// --- Sector mapping ---

/** A SIC-code range mapped to a human-readable sector name. */
export interface SicRange {
	min: number;
	max: number;
	sector: string;
}

// --- Universe reconcile ---

/** One active-universe row from Massive's list endpoint. */
export interface ActiveTicker {
	symbol: string;
	name: string;
	type: "stock" | "etf";
	lastUpdatedUtc: string;
	compositeFigi: string | null;
}

/** Detail-fetch result returned by the Massive enrichment seam. */
export type TickerDetail = { ok: boolean; iconUrl: string | null; sector: string | null };

/** A stored `assets` row, the subset reconcile reads for classification + enrichment gating. */
export interface StoredAsset {
	symbol: string;
	name: string;
	delisted_at: string | null;
	sector: string | null;
	icon_url: string | null;
	reference_updated_utc: string | null;
}

/** Dependencies for `runUniverseReconcile`. */
export interface UniverseReconcileDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	/** Per-run enrichment cap. Defaults to 500. */
	enrichmentCap?: number;
	/** Bounded detail-fetch concurrency. Defaults to 20. */
	enrichmentConcurrency?: number;
}

/** Summary counters returned by `runUniverseReconcile`. */
export interface UniverseReconcileResult {
	/** Size of the de-duplicated active set fetched from Massive. */
	activeTickersFetched: number;
	/** Active symbols that did not previously exist in `assets`. */
	newListingsInserted: number;
	/** Existing rows whose `name` changed in the active set. */
	namesUpdated: number;
	/** Upsert chunks that failed to write (partial coverage — surfaced in the summary). */
	upsertChunksFailed: number;
	/** Previously-flagged rows set back to `delisted_at = null` (reappeared). */
	delistedCleared: number;
	/** Untracked stored symbols absent from the active set, newly flagged delisted. */
	untrackedDelistedFlagged: number;
	/** True when step 3 skipped flagging because the active set was implausibly small. */
	delistFlagSkippedShrunkActive: boolean;
	/** Candidates for enrichment (new ∪ stale-reference ∪ missing-enrichment), pre-cap. */
	enrichmentCandidates: number;
	/** Detail calls that succeeded and wrote sector/icon. */
	enriched: number;
	/** Detail calls that returned `ok:false` or threw. */
	enrichmentFailed: number;
	/** Candidates beyond the cap, deferred to a subsequent run. */
	enrichmentSkippedCap: number;
	/** New symbols successfully enqueued for warmup. */
	warmupEnqueued: number;
	/** New symbols whose warmup enqueue returned false. */
	warmupEnqueueFailed: number;
	/** True when step 1 returned an empty set — the run aborted before any mutation. */
	providerFetchFailed: boolean;
}

// --- Delisting sweep ---

/** Dependencies for `runDelistingSweep`. */
export interface DelistingSweepDeps {
	supabase: SupabaseAdminClient;
	logger: Logger;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
}

/** Summary counters returned by `runDelistingSweep`. */
export interface DelistingSweepResult {
	symbolsChecked: number;
	newlyDetectedDelistings: number;
	reprocessedDelistings: number;
	/** Users who received at least one successful delivery on any channel. */
	usersNotified: number;
	emailsDelivered: number;
	emailsSkippedOptOut: number;
	emailsFailed: number;
	smsDelivered: number;
	smsSkippedOptOut: number;
	smsFailed: number;
	userAssetRowsDeleted: number;
	priceTargetRowsDeleted: number;
	providerErrors: number;
}
