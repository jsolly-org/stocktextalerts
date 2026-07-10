import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { fetchTickerDetail, isAllowedLogoUrl } from "./reference/ticker-detail";
import type {
	EnsureAssetIconCheckedDeps,
	EnsureAssetIconCheckedResult,
	TickerDetail,
} from "./types";

/**
 * Probe Massive for a single asset's logo when it has never been checked, or
 * when `force` is set (Massive reference watermark advanced).
 *
 * Used on watchlist add, universe reconcile new listings, and watermark-gated
 * refreshes. No-ops when the row is missing or delisted; without `force`, also
 * no-ops when already stamped. Failures are non-throwing for the caller —
 * transport/write issues leave the row unchecked (and are logged here). There
 * is no nightly drip; a later add/reconcile retry is the only automatic path.
 */
export async function ensureAssetIconChecked(
	deps: EnsureAssetIconCheckedDeps,
): Promise<EnsureAssetIconCheckedResult> {
	const { supabase, logger, symbol, force = false } = deps;
	const getTickerDetail = deps.getTickerDetail ?? fetchTickerDetail;

	const { data, error } = await supabase
		.from("assets")
		.select("icon_url, icon_checked_at, delisted_at")
		.eq("symbol", symbol)
		.maybeSingle();
	if (error) {
		logger.warn(
			"Icon probe failed to read asset row",
			{ action: "icon_check", step: "load", symbol },
			error,
		);
		return { probed: false, iconUrl: null };
	}
	if (!data || data.delisted_at !== null) {
		return { probed: false, iconUrl: data?.icon_url ?? null };
	}
	if (!force && data.icon_checked_at !== null) {
		return { probed: false, iconUrl: data.icon_url };
	}

	const outcome = await checkAndStoreIcon({
		supabase,
		logger,
		symbol,
		getTickerDetail,
		preserveExistingOnNull: force,
		existingIconUrl: data.icon_url,
	});
	if (outcome.kind === "checked") {
		return { probed: true, iconUrl: outcome.iconUrl };
	}
	return { probed: false, iconUrl: data.icon_url };
}

type CheckOutcome =
	| { kind: "checked"; iconUrl: string | null }
	| { kind: "fetch_failed" }
	| { kind: "write_failed" };

async function checkAndStoreIcon(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	symbol: string;
	getTickerDetail: (symbol: string) => Promise<TickerDetail>;
	logAction?: string;
	preserveExistingOnNull?: boolean;
	existingIconUrl?: string | null;
}): Promise<CheckOutcome> {
	const { supabase, logger, symbol, getTickerDetail, logAction = "icon_check" } = options;

	let detail: TickerDetail;
	try {
		detail = await getTickerDetail(symbol);
	} catch (err) {
		logger.warn("Icon detail fetch threw", { action: logAction, step: "fetch", symbol }, err);
		return { kind: "fetch_failed" };
	}
	if (!detail.ok) {
		logger.warn("Icon detail fetch soft-failed (will retry)", {
			action: logAction,
			step: "fetch",
			symbol,
		});
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

	// Force re-probe: Massive detail can 404 on list/detail lag. Do not wipe a
	// previously good logo on a null answer — keep last good and still stamp checked.
	if (options.preserveExistingOnNull && iconUrl === null && options.existingIconUrl) {
		logger.warn("Force icon probe got null; keeping last good logo", {
			action: logAction,
			step: "preserve",
			symbol,
		});
		iconUrl = options.existingIconUrl;
	}

	// Clear icon_base64 whenever we rewrite icon_url so email's cached data-URI
	// cannot outlive a Massive branding URL change.
	const { error: writeErr } = await supabase
		.from("assets")
		.update({
			icon_url: iconUrl,
			icon_checked_at: new Date().toISOString(),
			icon_base64: null,
		})
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
