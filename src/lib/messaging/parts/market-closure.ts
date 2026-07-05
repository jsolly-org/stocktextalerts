/**
 * Shared market closure banner helpers for notification pipelines.
 *
 * Used by asset-events and market-scheduled notifications to display
 * market-closed context, mirroring the daily digest banner style.
 */

import type { MarketClosureInfo } from "../../time/types";
import { escapeHtml } from "./html-utils";

/** Build a human-readable market closure label. */
export function buildMarketClosureLabel(closureInfo: MarketClosureInfo): string {
	if (closureInfo.reason === "holiday" && closureInfo.holidayName) {
		return `Market Closed — ${closureInfo.holidayName}`;
	}
	if (closureInfo.reason === "weekend") {
		return "Market Closed — Weekend";
	}
	return "Market Closed";
}

type MarketClosedBannerContext = "prices" | "events";

/** Build the subline, optionally appending an "as of {asOf}" staleness hint to the
 *  prices variant (e.g. the daily digest passes its latest quote timestamp). */
function buildSubline(context: MarketClosedBannerContext, asOf?: string | null): string {
	if (context === "events") {
		return "Event dates are as scheduled.";
	}
	const asOfSuffix = asOf ? ` (as of ${asOf})` : "";
	return `Prices below reflect the last market close${asOfSuffix}.`;
}

/** Shared private core producing the exact plaintext market-closed banner. Each
 *  channel's `buildMarketClosedBanner*` delegates here so their bytes stay identical. */
function renderMarketClosedBannerPlain(
	closureInfo?: MarketClosureInfo | null,
	context: MarketClosedBannerContext = "prices",
	asOf?: string | null,
): string {
	const subline = buildSubline(context, asOf);
	if (closureInfo) {
		const label = buildMarketClosureLabel(closureInfo);
		return `🔔 ${label}\n${subline}`;
	}
	return `🔔 Market Closed\n${subline}`;
}

/** Build the plain-text market-closed banner for the email text body. */
export function buildMarketClosedBannerEmailText(
	closureInfo?: MarketClosureInfo | null,
	context: MarketClosedBannerContext = "prices",
	asOf?: string | null,
): string {
	return renderMarketClosedBannerPlain(closureInfo, context, asOf);
}

/** Build the plain-text market-closed banner for Telegram. */
export function buildMarketClosedBannerTelegram(
	closureInfo?: MarketClosureInfo | null,
	context: MarketClosedBannerContext = "prices",
	asOf?: string | null,
): string {
	return renderMarketClosedBannerPlain(closureInfo, context, asOf);
}

/** Build an HTML market-closed banner matching the daily digest style. */
export function buildMarketClosedBannerEmailHtml(
	closureInfo?: MarketClosureInfo | null,
	context: MarketClosedBannerContext = "prices",
	asOf?: string | null,
): string {
	// `asOf` is interpolated raw here and escaped with the rest of the subline below.
	const subline = buildSubline(context, asOf);
	const label = closureInfo ? escapeHtml(buildMarketClosureLabel(closureInfo)) : "Market Closed";
	return `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: center;">
			<div style="font-size: 14px; color: #92400e; font-weight: 600;">🔔 ${label}</div>
			<div style="font-size: 12px; color: #92400e; margin-top: 4px;">${escapeHtml(subline)}</div>
		</div>`;
}
