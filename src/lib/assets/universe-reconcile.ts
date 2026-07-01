import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging/types";
import { enqueueNewSymbolWarmup } from "../vendors/backfill/enqueue";
import {
	CHUNK_SIZE,
	DEFAULT_ENRICHMENT_CAP,
	DEFAULT_ENRICHMENT_CONCURRENCY,
	MIN_PLAUSIBLE_ACTIVE_UNIVERSE,
} from "./constants";
import { fetchTickerDetail } from "./reference/ticker-detail";
import { fetchActiveTickers } from "./reference/universe";
import type {
	ActiveTicker,
	StoredAsset,
	TickerDetail,
	UniverseReconcileDeps,
	UniverseReconcileResult,
} from "./types";
import { activeSetTooSmallToFlag } from "./universe-reconcile-floor";

const EMPTY_RESULT: UniverseReconcileResult = {
	activeTickersFetched: 0,
	newListingsInserted: 0,
	namesUpdated: 0,
	upsertChunksFailed: 0,
	delistedCleared: 0,
	untrackedDelistedFlagged: 0,
	delistFlagSkippedShrunkActive: false,
	enrichmentCandidates: 0,
	enriched: 0,
	enrichmentFailed: 0,
	enrichmentSkippedCap: 0,
	warmupEnqueued: 0,
	warmupEnqueueFailed: 0,
	providerFetchFailed: false,
};

function chunksOf<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * Decide whether an active ticker needs (re-)enrichment.
 *
 * Re-qualifies on missing enrichment as well as an advanced reference timestamp:
 * step 2 already wrote `reference_updated_utc` for *every* active symbol, so a
 * capped-out candidate's stored timestamp now equals the incoming value and would
 * never re-qualify on the advance check alone. Gating on missing `sector`/`icon_url`
 * is what lets the backlog drain past one cap's worth over subsequent runs.
 *
 * ETFs legitimately have a null `sector` (no SIC code), so for ETFs we gate on
 * `icon_url` only — otherwise they would re-enrich forever.
 */
function needsEnrichment(ticker: ActiveTicker, prior: StoredAsset | undefined): boolean {
	if (!prior) return true; // new symbol
	if (prior.icon_url === null) return true; // never got an icon
	if (ticker.type === "stock" && prior.sector === null) return true; // stock missing sector
	if (!prior.reference_updated_utc) return true; // pre-migration / never enriched
	if (!ticker.lastUpdatedUtc) return false; // can't gate without a value → don't churn
	// Compare by parsed instant, NOT lexicographically: Massive emits `...Z` ISO
	// timestamps while Postgres returns the same instant as `...+00:00`, so a string
	// compare ("...Z" > "...+00:00") spuriously fires on every already-enriched
	// symbol and re-enriches the whole universe every run. Parse to epoch ms instead.
	const incomingMs = Date.parse(ticker.lastUpdatedUtc);
	const storedMs = Date.parse(prior.reference_updated_utc);
	if (Number.isNaN(incomingMs) || Number.isNaN(storedMs)) return true; // unparseable → enrich
	return incomingMs > storedMs;
}

/**
 * Run detail fetches over `candidates` with bounded concurrency, writing
 * `icon_url` (always) and `sector` (stocks only) per symbol. Mutates `result`.
 */
async function enrichSymbols(
	candidates: ActiveTicker[],
	deps: {
		supabase: SupabaseAdminClient;
		logger: Logger;
		getTickerDetail: (symbol: string) => Promise<TickerDetail>;
		concurrency: number;
	},
	result: UniverseReconcileResult,
): Promise<void> {
	const { supabase, logger, getTickerDetail, concurrency } = deps;

	for (const batch of chunksOf(candidates, concurrency)) {
		await Promise.all(
			batch.map(async (ticker) => {
				let detail: TickerDetail;
				try {
					detail = await getTickerDetail(ticker.symbol);
				} catch (error) {
					result.enrichmentFailed += 1;
					logger.warn(
						"Universe reconcile detail fetch threw",
						{ action: "universe_reconcile", step: "enrich", symbol: ticker.symbol },
						error,
					);
					return;
				}

				if (!detail.ok) {
					// Don't null out existing data on a provider miss — leave the row as-is.
					result.enrichmentFailed += 1;
					return;
				}

				// ETFs have no SIC code → never set sector for them (it would always be null).
				const update =
					ticker.type === "stock"
						? { icon_url: detail.iconUrl, sector: detail.sector }
						: { icon_url: detail.iconUrl };

				const { error } = await supabase.from("assets").update(update).eq("symbol", ticker.symbol);
				if (error) {
					result.enrichmentFailed += 1;
					logger.error(
						"Universe reconcile failed to write enrichment",
						{ action: "universe_reconcile", step: "enrich", symbol: ticker.symbol },
						error,
					);
					return;
				}
				result.enriched += 1;
			}),
		);
	}
}

/**
 * Daily ticker-universe reconcile. Intended to run inside the asset-maintenance
 * Lambda (once per day) BEFORE `runDelistingSweep`, in its own try/catch so a
 * reconcile failure never invalidates the sweep or the calendar-events job.
 *
 * Flow:
 *   1. Fetch the complete active US stock/ETF universe from Massive (bulk list).
 *      If it comes back empty, abort BEFORE any mutation — an empty universe is
 *      impossible in practice, so empty ⇒ provider failure, and flagging the
 *      entire stored universe delisted would be catastrophic. This is the single
 *      most important safety gate in the module.
 *   2. Load stored `assets` state, classify new / name-changed / reappeared, then
 *      upsert every active symbol (insert new listings, refresh names, and clear
 *      `delisted_at` on any symbol that reappeared active). Persists the two new
 *      reference columns (`reference_updated_utc`, `composite_figi`).
 *   3. Bulk-flag `delisted_at` on stored symbols ABSENT from the active set — but
 *      ONLY for UNtracked symbols. Tracked (user_assets) symbols are never flagged
 *      here; tracked delisting stays exclusively on the confirm-based sweep, which
 *      does not re-confirm an already-flagged row before notify+remove, so a
 *      false-positive flag there would wrongly delete a live subscription.
 *   4. Enrich sector/icon for new symbols and symbols whose reference advanced or
 *      whose enrichment is missing, capped per run with bounded concurrency.
 *   5. Enqueue a warmup backfill for each newly-inserted symbol.
 *
 * Each of steps 2–5 runs in its own try/catch and never throws past the handler,
 * matching the sweep's per-step isolation.
 */
export async function runUniverseReconcile(
	deps: UniverseReconcileDeps,
): Promise<UniverseReconcileResult> {
	const { supabase, logger } = deps;
	const enrichmentCap = deps.enrichmentCap ?? DEFAULT_ENRICHMENT_CAP;
	const enrichmentConcurrency = deps.enrichmentConcurrency ?? DEFAULT_ENRICHMENT_CONCURRENCY;

	const result: UniverseReconcileResult = { ...EMPTY_RESULT };

	// --- Step 1: Fetch the active set. ---
	const active = await fetchActiveTickers();
	result.activeTickersFetched = active.length;
	if (active.length === 0) {
		// A genuinely empty universe is impossible, so an empty result means the
		// provider failed. Returning here is the load-bearing safety gate: it
		// prevents steps 2–3 from flagging the entire stored universe delisted.
		// Log at error, not warn: this is a fully-dark provider (strictly worse
		// than the short-but-nonempty fetch that step 3 already logs at error),
		// the run aborts with no work done, and an empty-but-200 on the bulk-list
		// endpoint need not trip any other Massive consumer's alarm — so this is
		// the only signal a silently-darkened universe job produces. Must reach
		// ErrorLogAlarm.
		logger.error(
			"Universe reconcile got an empty active set — treating as provider failure and aborting",
			{ action: "universe_reconcile", step: "fetch" },
		);
		return { ...result, providerFetchFailed: true };
	}
	const activeSymbols = new Set(active.map((t) => t.symbol));

	// Load stored state once — used by steps 2, 3 and 4. A read failure here makes
	// the whole run meaningless, so this one throws (caught by the handler).
	//
	// Paginate: PostgREST caps an unbounded `.select()` at ~1000 rows, and the prod
	// `assets` table holds ~27k. A truncated read would silently misclassify every
	// symbol past the cap as "new" (spurious inserts/warmups, missed name/reappear
	// detection) AND, worse, never flag untracked delistings beyond the cap — the
	// backlog-drain this job exists for would do ~4% of its work. Page through the
	// whole table ordered by the `symbol` PK.
	const storedRows: StoredAsset[] = [];
	const STORED_PAGE_SIZE = 1000;
	for (let from = 0; ; from += STORED_PAGE_SIZE) {
		const { data: page, error: storedErr } = await supabase
			.from("assets")
			.select("symbol, name, delisted_at, sector, icon_url, reference_updated_utc")
			.order("symbol", { ascending: true })
			.range(from, from + STORED_PAGE_SIZE - 1);
		if (storedErr) {
			logger.error(
				"Universe reconcile failed to load stored assets",
				{ action: "universe_reconcile", step: "load_stored", from },
				storedErr,
			);
			throw storedErr;
		}
		const rows = page ?? [];
		for (const r of rows) storedRows.push(r as StoredAsset);
		if (rows.length < STORED_PAGE_SIZE) break;
	}
	const stored = new Map<string, StoredAsset>(storedRows.map((r) => [r.symbol, r]));

	// Classify against the pre-upsert stored map — supabase-js upsert can't report
	// insert-vs-update per row, so new/changed/reappeared must be computed here.
	const newSymbols: string[] = [];
	for (const t of active) {
		const prior = stored.get(t.symbol);
		if (!prior) {
			newSymbols.push(t.symbol);
			result.newListingsInserted += 1;
			continue;
		}
		if (prior.name !== t.name) result.namesUpdated += 1;
		if (prior.delisted_at !== null) result.delistedCleared += 1;
	}

	// --- Step 2: Upsert the active set (insert + name refresh + clear delisted). ---
	// Every active symbol carries `delisted_at: null`, which clears the flag on any
	// reappeared symbol (harmless no-op for already-null rows). NOTE: this can also
	// clear a `delisted_at` that the confirm-based sweep set on a *tracked* symbol
	// that is nonetheless present in Massive's active set — that is correct (it IS
	// active, so the sweep's flag was stale), but it means reconcile can un-flag a
	// tracked symbol the sweep flagged.
	// Symbols whose upsert chunk failed — excluded from step 5 warmup, since a failed
	// upsert may mean the row is not in `assets` and warming a phantom symbol just churns.
	const failedUpsertSymbols = new Set<string>();
	try {
		const upsertRows = active.map((t) => ({
			symbol: t.symbol,
			name: t.name,
			type: t.type,
			delisted_at: null,
			reference_updated_utc: t.lastUpdatedUtc || null,
			composite_figi: t.compositeFigi,
		}));
		for (const chunk of chunksOf(upsertRows, CHUNK_SIZE)) {
			const { error } = await supabase.from("assets").upsert(chunk, { onConflict: "symbol" });
			if (error) {
				result.upsertChunksFailed += 1;
				for (const row of chunk) failedUpsertSymbols.add(row.symbol);
				logger.error(
					"Universe reconcile upsert chunk failed",
					{ action: "universe_reconcile", step: "upsert", chunkSize: chunk.length },
					error,
				);
			}
		}
	} catch (error) {
		logger.error(
			"Universe reconcile upsert step threw",
			{ action: "universe_reconcile", step: "upsert" },
			error,
		);
	}

	// --- Step 3: Bulk-flag untracked delistings (tracked carve-out). ---
	try {
		// Page through user_assets the same way the stored-assets load does. This read
		// IS the tracked carve-out's only input: an unbounded `.select()` truncates at
		// PostgREST's ~1000-row cap, so tracked symbols beyond the cap would fall out of
		// the set and a tracked-but-inactive symbol could be flagged delisted — the sweep
		// would then notify+remove a live subscription without re-confirming. Pagination
		// keeps the carve-out total at any scale.
		const trackedSymbols = new Set<string>();
		const TRACKED_PAGE_SIZE = 1000;
		for (let from = 0; ; from += TRACKED_PAGE_SIZE) {
			const { data: page, error: trackedErr } = await supabase
				.from("user_assets")
				.select("symbol")
				.order("symbol", { ascending: true })
				.range(from, from + TRACKED_PAGE_SIZE - 1);
			if (trackedErr) throw trackedErr;
			const rows = page ?? [];
			for (const r of rows) trackedSymbols.add(r.symbol);
			if (rows.length < TRACKED_PAGE_SIZE) break;
		}

		// Defense-in-depth against a silently-truncated active set (a provider returning a
		// valid-but-short response with no pagination error — fetchActiveTickers already
		// throws on a detectable mid-pagination failure, so this guards the residual case).
		// The floor is absolute, not a fraction of stored-active — see MIN_PLAUSIBLE_ACTIVE_UNIVERSE
		// for why a stored-relative floor would deadlock the drain. Skip flagging rather than
		// mass-delist live symbols: step 2's upsert still ran, only the delete-class op is held
		// back, so a false trip merely defers cleanup one run.
		if (activeSetTooSmallToFlag(active.length)) {
			result.delistFlagSkippedShrunkActive = true;
			logger.error("Universe reconcile: active set implausibly small — skipping delist flag", {
				action: "universe_reconcile",
				step: "flag_delisted",
				activeCount: active.length,
				floor: MIN_PLAUSIBLE_ACTIVE_UNIVERSE,
			});
		} else {
			// Stored symbols absent from the active set, not already flagged, and NOT tracked.
			// The `!trackedSymbols.has(...)` filter IS the tracked carve-out: a tracked symbol
			// can never enter `toFlag`, so reconcile never stamps `delisted_at` on a tracked
			// symbol. Tracked delisting stays 100% on the confirm-based sweep.
			const toFlag = storedRows
				.filter(
					(r) =>
						r.delisted_at === null && !activeSymbols.has(r.symbol) && !trackedSymbols.has(r.symbol),
				)
				.map((r) => r.symbol);

			const nowIso = new Date().toISOString();
			for (const chunk of chunksOf(toFlag, CHUNK_SIZE)) {
				const { error, count } = await supabase
					.from("assets")
					.update({ delisted_at: nowIso }, { count: "exact" })
					.in("symbol", chunk)
					.is("delisted_at", null); // defensive: never re-stamp an already-flagged row
				if (error) {
					logger.error(
						"Universe reconcile failed to flag untracked delistings",
						{ action: "universe_reconcile", step: "flag_delisted", chunkSize: chunk.length },
						error,
					);
					continue;
				}
				result.untrackedDelistedFlagged += count ?? 0;
			}
		}
	} catch (error) {
		logger.error(
			"Universe reconcile delist-flag step threw",
			{ action: "universe_reconcile", step: "flag_delisted" },
			error,
		);
	}

	// --- Step 4: Capped enrichment (sector/icon for new + stale + missing). ---
	try {
		const candidates = active.filter((t) => needsEnrichment(t, stored.get(t.symbol)));
		result.enrichmentCandidates = candidates.length;
		const toEnrich = candidates.slice(0, enrichmentCap);
		result.enrichmentSkippedCap = candidates.length - toEnrich.length;
		await enrichSymbols(
			toEnrich,
			{ supabase, logger, getTickerDetail: fetchTickerDetail, concurrency: enrichmentConcurrency },
			result,
		);
	} catch (error) {
		logger.error(
			"Universe reconcile enrichment step threw",
			{ action: "universe_reconcile", step: "enrich" },
			error,
		);
	}

	// --- Step 5: Warm newly-inserted symbols (not name-changed). ---
	try {
		for (const symbol of newSymbols) {
			// A new symbol whose upsert chunk failed isn't in `assets`; warming it would
			// enqueue backfill for a phantom symbol. Skip those.
			if (failedUpsertSymbols.has(symbol)) continue;
			const ok = await enqueueNewSymbolWarmup({ symbol, reason: "universe_reconcile_new_listing" });
			if (ok) result.warmupEnqueued += 1;
			else result.warmupEnqueueFailed += 1;
		}
	} catch (error) {
		logger.error(
			"Universe reconcile warmup step threw",
			{ action: "universe_reconcile", step: "warmup" },
			error,
		);
	}

	return result;
}
