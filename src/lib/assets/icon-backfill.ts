import { ICON_BACKFILL_CONCURRENCY, ICON_BACKFILL_NIGHTLY_CAP } from "./constants";
import { fetchTickerDetail, isAllowedLogoUrl } from "./reference/ticker-detail";
import type { IconBackfillDeps, IconBackfillResult } from "./types";
import { chunksOf } from "./universe-reconcile";

/**
 * Nightly icon backfill: probe Finnhub `/stock/profile2` for symbols that have never
 * been checked (`icon_checked_at IS NULL`), capped per run.
 *
 * Stamping `icon_checked_at` on EVERY definitive answer — including "Finnhub has no
 * logo for this symbol" — is the fix for the enrichment treadmill: a logo-less symbol
 * is checked exactly once instead of re-qualifying every night and wedging the cap
 * window. Only transport failures leave a symbol unchecked (retried on a later run).
 * New listings insert with a NULL `icon_checked_at`, so the drip picks them up
 * automatically.
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

	// A read failure makes the run meaningless — throw to the handler's try/catch.
	// NOTE: PostgREST's max_rows (default 1000) silently clamps `.limit()` above it,
	// so `cap` must stay ≤ 1000 — page with `.range()` before ever raising it past that.
	const { data, error, count } = await supabase
		.from("assets")
		.select("symbol", { count: "exact" })
		.is("icon_checked_at", null)
		.is("delisted_at", null)
		.order("symbol", { ascending: true })
		.limit(cap);
	if (error) {
		logger.error(
			"Icon backfill failed to load candidates",
			{ action: "icon_backfill", step: "load_candidates" },
			error,
		);
		throw error;
	}
	result.candidatesRemaining = count ?? 0;
	const candidates = (data ?? []).map((r) => r.symbol);

	for (const batch of chunksOf(candidates, concurrency)) {
		await Promise.all(
			batch.map(async (symbol) => {
				let detail: Awaited<ReturnType<typeof getTickerDetail>>;
				try {
					detail = await getTickerDetail(symbol);
				} catch (err) {
					result.fetchFailed += 1;
					logger.warn(
						"Icon backfill detail fetch threw",
						{ action: "icon_backfill", step: "fetch", symbol },
						err,
					);
					return;
				}
				if (!detail.ok) {
					// Transport failure — leave the row unchecked so a later run retries.
					result.fetchFailed += 1;
					return;
				}

				// Write-time gate (defense-in-depth behind the read-time resolver): a
				// vendor URL off the allowlist is stored as "checked, no icon" rather
				// than silently 404ing every read forever.
				let iconUrl = detail.iconUrl;
				if (iconUrl !== null && !isAllowedLogoUrl(iconUrl)) {
					logger.warn("Icon backfill rejected non-allowlisted logo URL", {
						action: "icon_backfill",
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
					result.writeFailed += 1;
					logger.error(
						"Icon backfill failed to write result",
						{ action: "icon_backfill", step: "write", symbol },
						writeErr,
					);
					return;
				}
				result.checked += 1;
				if (iconUrl !== null) result.iconsFound += 1;
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
