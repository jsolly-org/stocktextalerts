/**
 * Shared market closure banner helpers for notification pipelines.
 *
 * Used by asset-events and market-scheduled notifications to display
 * market-closed context, mirroring the daily digest banner style.
 */

import type { MarketClosureInfo } from "../time/market-calendar";
import { escapeHtml } from "./asset-formatting";

/** Build a human-readable market closure label. */
export function buildMarketClosureLabel(
	closureInfo: MarketClosureInfo,
): string {
	if (closureInfo.reason === "holiday" && closureInfo.holidayName) {
		return `Market Closed — ${closureInfo.holidayName}`;
	}
	if (closureInfo.reason === "weekend") {
		return "Market Closed — Weekend";
	}
	return "Market Closed";
}

/** Build a plain-text market-closed banner. */
export function buildMarketClosedBannerText(
	closureInfo?: MarketClosureInfo | null,
): string {
	if (closureInfo) {
		const label = buildMarketClosureLabel(closureInfo);
		return `🔔 ${label}\nPrices below reflect the last market close.`;
	}
	return "🔔 Market Closed\nPrices below reflect the last market close.";
}

/** Build an HTML market-closed banner matching the daily digest style. */
export function buildMarketClosedBannerHtml(
	closureInfo?: MarketClosureInfo | null,
): string {
	const label = closureInfo
		? escapeHtml(buildMarketClosureLabel(closureInfo))
		: "Market Closed";
	return `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: center;">
			<div style="font-size: 14px; color: #92400e; font-weight: 600;">🔔 ${label}</div>
			<div style="font-size: 12px; color: #92400e; margin-top: 4px;">Prices below reflect the last market close.</div>
		</div>`;
}
