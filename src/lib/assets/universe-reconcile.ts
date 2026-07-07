import { enqueueNewSymbolWarmup } from "../vendors/backfill/enqueue";
import {
	CHUNK_SIZE,
	MAX_WARMUP_ENQUEUES_PER_RUN,
	MIN_PLAUSIBLE_ACTIVE_UNIVERSE,
} from "./constants";
import { fetchActiveTickers } from "./reference/universe";
import type { StoredAsset, UniverseReconcileDeps, UniverseReconcileResult } from "./types";

/** True when the fetched active set is below the plausibility floor. */
export function activeSetTooSmallToFlag(activeCount: number): boolean {
	return activeCount < MIN_PLAUSIBLE_ACTIVE_UNIVERSE;
}

const EMPTY_RESULT: UniverseReconcileResult = {
	activeTickersFetched: 0,
	allActiveSymbols: 0,
	newListingsInserted: 0,
	insertChunksFailed: 0,
	delistedCleared: 0,
	untrackedDelistedFlagged: 0,
	delistFlagSkippedShrunkActive: false,
	warmupEnqueued: 0,
	warmupEnqueueFailed: 0,
	warmupSkippedCap: 0,
	providerFetchFailed: false,
};

/** Shared by reconcile and the icon backfill — bounds `.in()` filter URLs and write batches. */
export function chunksOf<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * Weekly ticker-universe reconcile. Intended to run inside the asset-maintenance
 * Lambda BEFORE `runDelistingSweep`, in its own try/catch so a reconcile failure
 * never invalidates the sweep or the calendar-events job. Icon enrichment is NOT
 * part of reconcile — the nightly `runIconBackfill` drains never-checked symbols
 * on its own cadence.
 *
 * Flow:
 *   1. Fetch the active US listing from Finnhub (one call). If it comes back empty,
 *      abort BEFORE any mutation — an empty universe is impossible in practice, so
 *      empty ⇒ provider failure, and flagging the entire stored universe delisted
 *      would be catastrophic. This is the single most important safety gate in the
 *      module.
 *   2. Load stored `assets` state, then INSERT new stock/etf listings and clear
 *      `delisted_at` on any stored symbol that reappeared in the active superset.
 *      Existing rows' names are never rewritten (Finnhub names are upper-case;
 *      Massive-era proper-case names are better and only new rows take the new
 *      source's spelling).
 *   3. Bulk-flag `delisted_at` on stored symbols ABSENT from the active SUPERSET
 *      (all security types, not just the stock/etf subset — a type-classification
 *      quirk must not read as "vanished") — but ONLY for UNtracked symbols. Tracked
 *      (user_assets) symbols are never flagged here; tracked delisting stays
 *      exclusively on the confirm-based sweep, which does not re-confirm an
 *      already-flagged row before notify+remove, so a false-positive flag there
 *      would wrongly delete a live subscription.
 *   4. Enqueue a warmup backfill for newly-inserted symbols, capped per run so a
 *      large new-listing delta can't become an SQS backfill storm.
 *
 * Each of steps 2–4 runs in its own try/catch and never throws past the handler,
 * matching the sweep's per-step isolation.
 */
export async function runUniverseReconcile(
	deps: UniverseReconcileDeps,
): Promise<UniverseReconcileResult> {
	const { supabase, logger } = deps;
	const warmupCap = deps.warmupCap ?? MAX_WARMUP_ENQUEUES_PER_RUN;

	const result: UniverseReconcileResult = { ...EMPTY_RESULT };

	// --- Step 1: Fetch the active set. ---
	const { tickers: active, allActiveSymbols } = await fetchActiveTickers();
	result.activeTickersFetched = active.length;
	result.allActiveSymbols = allActiveSymbols.size;
	if (active.length === 0) {
		// A genuinely empty universe is impossible, so an empty result means the
		// provider failed. Returning here is the load-bearing safety gate: it
		// prevents steps 2–3 from flagging the entire stored universe delisted.
		// Log at error, not warn: this is a fully-dark provider, the run aborts
		// with no work done, and this is the only signal a silently-darkened
		// universe job produces. Must reach ErrorLogAlarm.
		logger.error(
			"Universe reconcile got an empty active set — treating as provider failure and aborting",
			{ action: "universe_reconcile", step: "fetch" },
		);
		return { ...result, providerFetchFailed: true };
	}

	// Load stored state once — used by steps 2 and 3. A read failure here makes
	// the whole run meaningless, so this one throws (caught by the handler).
	//
	// Paginate: PostgREST caps an unbounded `.select()` at ~1000 rows, and the prod
	// `assets` table holds ~27k. A truncated read would silently misclassify every
	// symbol past the cap as "new" (spurious inserts/warmups) AND, worse, never flag
	// untracked delistings beyond the cap — the backlog-drain this job exists for
	// would do ~4% of its work. Page through the whole table ordered by the `symbol` PK.
	const storedRows: StoredAsset[] = [];
	const STORED_PAGE_SIZE = 1000;
	for (let from = 0; ; from += STORED_PAGE_SIZE) {
		const { data: page, error: storedErr } = await supabase
			.from("assets")
			.select("symbol, delisted_at")
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
	const storedSymbols = new Set(storedRows.map((r) => r.symbol));

	// --- Step 2: Insert new listings + clear delisted_at on reappeared symbols. ---
	// Symbols whose insert chunk failed are excluded from step 4 warmup, since a failed
	// insert may mean the row is not in `assets` and warming a phantom symbol just churns.
	const newTickers = active.filter((t) => !storedSymbols.has(t.symbol));
	const failedInsertSymbols = new Set<string>();
	try {
		for (const chunk of chunksOf(newTickers, CHUNK_SIZE)) {
			const rows = chunk.map((t) => ({
				symbol: t.symbol,
				name: t.name,
				type: t.type,
				delisted_at: null,
			}));
			// ignoreDuplicates: a concurrent insert (e.g. the search path) must not
			// turn the whole chunk into an error — existing rows are simply skipped.
			// count "exact" so the summary reports rows actually inserted, not attempted.
			const { error, count } = await supabase
				.from("assets")
				.upsert(rows, { onConflict: "symbol", ignoreDuplicates: true, count: "exact" });
			if (error) {
				result.insertChunksFailed += 1;
				for (const t of chunk) failedInsertSymbols.add(t.symbol);
				logger.error(
					"Universe reconcile insert chunk failed",
					{ action: "universe_reconcile", step: "insert", chunkSize: chunk.length },
					error,
				);
				continue;
			}
			result.newListingsInserted += count ?? chunk.length;
		}

		// Reappeared: stored rows flagged delisted that are present in the active
		// superset. NOTE: this can also clear a `delisted_at` the confirm-based sweep
		// set on a *tracked* symbol that is nonetheless actively listed — that is
		// correct (it IS active, so the sweep's flag was stale).
		const reappeared = storedRows
			.filter((r) => r.delisted_at !== null && allActiveSymbols.has(r.symbol))
			.map((r) => r.symbol);
		for (const chunk of chunksOf(reappeared, CHUNK_SIZE)) {
			const { error, count } = await supabase
				.from("assets")
				.update({ delisted_at: null }, { count: "exact" })
				.in("symbol", chunk);
			if (error) {
				logger.error(
					"Universe reconcile failed to clear reappeared delistings",
					{ action: "universe_reconcile", step: "clear_reappeared", chunkSize: chunk.length },
					error,
				);
				continue;
			}
			result.delistedCleared += count ?? 0;
		}
	} catch (error) {
		logger.error(
			"Universe reconcile insert step threw",
			{ action: "universe_reconcile", step: "insert" },
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

		// Defense-in-depth against a silently-truncated active set (a provider returning
		// a valid-but-short response). The floor is absolute, not a fraction of
		// stored-active — see MIN_PLAUSIBLE_ACTIVE_UNIVERSE for why a stored-relative
		// floor would deadlock the drain. Skip flagging rather than mass-delist live
		// symbols: step 2 still ran, only the delete-class op is held back, so a false
		// trip merely defers cleanup one run.
		if (activeSetTooSmallToFlag(active.length)) {
			result.delistFlagSkippedShrunkActive = true;
			logger.error("Universe reconcile: active set implausibly small — skipping delist flag", {
				action: "universe_reconcile",
				step: "flag_delisted",
				activeCount: active.length,
				floor: MIN_PLAUSIBLE_ACTIVE_UNIVERSE,
			});
		} else {
			// Stored symbols absent from the active SUPERSET, not already flagged, and NOT
			// tracked. The `!trackedSymbols.has(...)` filter IS the tracked carve-out: a
			// tracked symbol can never enter `toFlag`, so reconcile never stamps
			// `delisted_at` on a tracked symbol. Tracked delisting stays 100% on the
			// confirm-based sweep.
			const toFlag = storedRows
				.filter(
					(r) =>
						r.delisted_at === null &&
						!allActiveSymbols.has(r.symbol) &&
						!trackedSymbols.has(r.symbol),
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

	// --- Step 4: Warm newly-inserted symbols, capped per run. ---
	try {
		const warmable = newTickers
			.map((t) => t.symbol)
			.filter((symbol) => !failedInsertSymbols.has(symbol));
		const toWarm = warmable.slice(0, warmupCap);
		result.warmupSkippedCap = warmable.length - toWarm.length;
		if (result.warmupSkippedCap > 0) {
			// Skipped symbols are already inserted, so they are never "new" again — log
			// the (bounded) list so a manual follow-up warm remains possible.
			logger.warn("Universe reconcile warmup capped — skipped symbols will never warm", {
				action: "universe_reconcile",
				step: "warmup",
				skipped: result.warmupSkippedCap,
				cap: warmupCap,
				skippedSymbols: warmable.slice(warmupCap, warmupCap + 50),
			});
		}
		for (const symbol of toWarm) {
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
