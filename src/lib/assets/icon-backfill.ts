import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { ICON_BACKFILL_CONCURRENCY, ICON_BACKFILL_NIGHTLY_CAP } from "./constants";
import { fetchTickerDetail, isAllowedLogoUrl } from "./reference/ticker-detail";
import type {
	EnsureAssetIconCheckedDeps,
	EnsureAssetIconCheckedResult,
	IconBackfillDeps,
	IconBackfillResult,
	TickerDetail,
} from "./types";
import { chunksOf } from "./universe-reconcile";

/**
 * Nightly icon backfill: probe Massive ticker detail for symbols that have never been
 * checked (`icon_checked_at IS NULL`), capped per run.
 *
 * Tracked symbols (`user_assets`) fill the cap first so dashboard badges and digests
 * don't wait behind the alphabetical universe drip. Remaining slots fall back to
 * symbol order across the full unchecked set.
 *
 * Stamping `icon_checked_at` on EVERY definitive answer — including "Massive has no
 * logo for this symbol" — is the fix for the enrichment treadmill: a logo-less symbol
 * is checked exactly once instead of re-qualifying every night and wedging the cap
 * window. Only transport failures leave a symbol unchecked (retried on a later run).
 * New listings insert with a NULL `icon_checked_at`, so the drip picks them up
 * automatically. Watchlist adds also call {@link ensureAssetIconChecked} for an
 * immediate probe of net-new tracked symbols.
 */
export async function runIconBackfill(deps: IconBackfillDeps): Promise<IconBackfillResult> {
	const { supabase, logger } = deps;
	const cap = deps.cap ?? ICON_BACKFILL_NIGHTLY_CAP;
	const concurrency = deps.concurrency ?? ICON_BACKFILL_CONCURRENCY;
	const getTickerDetail = deps.getTickerDetail ?? fetchTickerDetail;

	const result: IconBackfillResult = {
		candidatesRemaining: 0,
		checked: 0,
		iconsFound: 0,
		fetchFailed: 0,
		writeFailed: 0,
	};

	const { candidates, candidatesRemaining } = await selectIconBackfillCandidates(
		supabase,
		logger,
		cap,
	);
	result.candidatesRemaining = candidatesRemaining;

	for (const batch of chunksOf(candidates, concurrency)) {
		await Promise.all(
			batch.map(async (symbol) => {
				const outcome = await checkAndStoreIcon({
					supabase,
					logger,
					symbol,
					getTickerDetail,
				});
				if (outcome.kind === "checked") {
					result.checked += 1;
					if (outcome.iconUrl !== null) result.iconsFound += 1;
				} else if (outcome.kind === "fetch_failed") {
					result.fetchFailed += 1;
				} else if (outcome.kind === "write_failed") {
					result.writeFailed += 1;
				}
			}),
		);
	}

	// A non-empty batch where NOTHING got a definitive answer means the profile
	// endpoint is fully dark — the drip would otherwise stall invisibly behind
	// per-probe warn/info lines. Must reach ErrorLogAlarm.
	if (candidates.length > 0 && result.checked === 0) {
		logger.error("Icon backfill probed a full batch with zero definitive answers", {
			action: "icon_backfill",
			step: "summary",
			probed: candidates.length,
			fetchFailed: result.fetchFailed,
			writeFailed: result.writeFailed,
		});
	}

	return result;
}

/**
 * Probe Massive for a single asset's logo when it has never been checked.
 * Used on watchlist add so tracked symbols don't wait for the nightly drip.
 * No-ops when the row is missing, delisted, or already stamped. Failures are
 * non-throwing for the caller — transport/write issues leave the row unchecked
 * for a later nightly retry (and are logged here).
 */
export async function ensureAssetIconChecked(
	deps: EnsureAssetIconCheckedDeps,
): Promise<EnsureAssetIconCheckedResult> {
	const { supabase, logger, symbol } = deps;
	const getTickerDetail = deps.getTickerDetail ?? fetchTickerDetail;

	const { data, error } = await supabase
		.from("assets")
		.select("icon_url, icon_checked_at, delisted_at")
		.eq("symbol", symbol)
		.maybeSingle();
	if (error) {
		logger.warn(
			"On-add icon probe failed to read asset row",
			{ action: "icon_on_add", step: "load", symbol },
			error,
		);
		return { probed: false, iconUrl: null };
	}
	if (!data || data.delisted_at !== null || data.icon_checked_at !== null) {
		return { probed: false, iconUrl: data?.icon_url ?? null };
	}

	const outcome = await checkAndStoreIcon({
		supabase,
		logger,
		symbol,
		getTickerDetail,
		logAction: "icon_on_add",
	});
	if (outcome.kind === "checked") {
		return { probed: true, iconUrl: outcome.iconUrl };
	}
	return { probed: false, iconUrl: null };
}

type CheckOutcome =
	| { kind: "checked"; iconUrl: string | null }
	| { kind: "fetch_failed" }
	| { kind: "write_failed" }
	| { kind: "skipped" };

async function checkAndStoreIcon(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	getTickerDetail: (symbol: string) => Promise<TickerDetail>;
	logAction?: string;
}): Promise<CheckOutcome> {
	const { supabase, logger, symbol, getTickerDetail, logAction = "icon_backfill" } = options;

	let detail: TickerDetail;
	try {
		detail = await getTickerDetail(symbol);
	} catch (err) {
		logger.warn("Icon detail fetch threw", { action: logAction, step: "fetch", symbol }, err);
		return { kind: "fetch_failed" };
	}
	if (!detail.ok) {
		return { kind: "fetch_failed" };
	}

	// Write-time gate (defense-in-depth behind the read-time resolver): a
	// vendor URL off the allowlist is stored as "checked, no icon" rather
	// than silently 404ing every read forever.
	let iconUrl = detail.iconUrl;
	if (iconUrl !== null && !isAllowedLogoUrl(iconUrl)) {
		logger.warn("Icon probe rejected non-allowlisted logo URL", {
			action: logAction,
			step: "validate",
			symbol,
		});
		iconUrl = null;
	}

	const { error: writeErr } = await supabase
		.from("assets")
		.update({ icon_url: iconUrl, icon_checked_at: new Date().toISOString() })
		.eq("symbol", symbol);
	if (writeErr) {
		logger.error(
			"Icon probe failed to write result",
			{ action: logAction, step: "write", symbol },
			writeErr,
		);
		return { kind: "write_failed" };
	}
	return { kind: "checked", iconUrl };
}

/**
 * Build the probe window: tracked unchecked symbols first (up to `cap`), then
 * fill remaining slots from the alphabetical never-checked universe.
 */
async function selectIconBackfillCandidates(
	supabase: SupabaseAdminClient,
	logger: Logger,
	cap: number,
): Promise<{ candidates: string[]; candidatesRemaining: number }> {
	// Total backlog for the summary counter (independent of prioritization).
	const { count, error: countError } = await supabase
		.from("assets")
		.select("symbol", { count: "exact", head: true })
		.is("icon_checked_at", null)
		.is("delisted_at", null);
	if (countError) {
		logger.error(
			"Icon backfill failed to count candidates",
			{ action: "icon_backfill", step: "count_candidates" },
			countError,
		);
		throw countError;
	}
	const candidatesRemaining = count ?? 0;

	const trackedUnchecked = await loadTrackedUncheckedSymbols(supabase, logger, cap);
	const candidates = [...trackedUnchecked];
	const selected = new Set(trackedUnchecked);

	const remaining = cap - candidates.length;
	if (remaining > 0) {
		// Pull a symbol-ordered window large enough to fill after skipping any
		// tracked symbols already selected. Cap+selected covers the worst case
		// where the first `cap` alphabetical rows are all already in `selected`.
		const windowSize = Math.min(cap + selected.size, 1000);
		const { data, error } = await supabase
			.from("assets")
			.select("symbol")
			.is("icon_checked_at", null)
			.is("delisted_at", null)
			.order("symbol", { ascending: true })
			.limit(windowSize);
		if (error) {
			logger.error(
				"Icon backfill failed to load drip candidates",
				{ action: "icon_backfill", step: "load_drip_candidates" },
				error,
			);
			throw error;
		}
		for (const row of data ?? []) {
			if (selected.has(row.symbol)) continue;
			candidates.push(row.symbol);
			selected.add(row.symbol);
			if (candidates.length >= cap) break;
		}
	}

	return { candidates, candidatesRemaining };
}

/** Distinct tracked symbols whose asset row is live and never icon-checked. */
async function loadTrackedUncheckedSymbols(
	supabase: SupabaseAdminClient,
	logger: Logger,
	limit: number,
): Promise<string[]> {
	const tracked = new Set<string>();
	const pageSize = 1000;
	for (let from = 0; ; from += pageSize) {
		const { data, error } = await supabase
			.from("user_assets")
			.select("symbol")
			.range(from, from + pageSize - 1);
		if (error) {
			logger.error(
				"Icon backfill failed to load tracked symbols",
				{ action: "icon_backfill", step: "load_tracked" },
				error,
			);
			throw error;
		}
		if (!data || data.length === 0) break;
		for (const row of data) tracked.add(row.symbol);
		if (data.length < pageSize) break;
	}
	if (tracked.size === 0) return [];

	const unchecked: string[] = [];
	for (const chunk of chunksOf([...tracked], 100)) {
		const { data, error } = await supabase
			.from("assets")
			.select("symbol")
			.in("symbol", chunk)
			.is("icon_checked_at", null)
			.is("delisted_at", null);
		if (error) {
			logger.error(
				"Icon backfill failed to filter tracked unchecked symbols",
				{ action: "icon_backfill", step: "filter_tracked" },
				error,
			);
			throw error;
		}
		for (const row of data ?? []) unchecked.push(row.symbol);
	}
	unchecked.sort((a, b) => a.localeCompare(b));
	return unchecked.slice(0, limit);
}
