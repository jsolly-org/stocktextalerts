import type { ActiveMarketSession } from "../market-notifications/scheduled/session-label";
import type { NoSessionTrade } from "../providers/price-fetcher";
import { EMAIL_SPARKLINE_LABEL, SMS_SPARKLINE_LABEL, type SparklineData } from "./sparkline";
import { toSvgSparklineImg } from "./svg-sparkline";
import type { EmailFormatContext } from "./types";

export type AssetPrice = {
	price: number;
	changePercent: number;
	/** Yesterday's close (Massive `prevDay.c`). Available on snapshot quotes. */
	prevClose?: number | null;
};

/**
 * Value a renderer can receive for a single asset:
 * - `AssetPrice` — live quote, render the price line.
 * - `"no_session_trade"` — ticker is in the snapshot but had no trade in
 *   the current session; render "no pre-market trades" / "no after-hours
 *   trades" when the session is pre/after, otherwise fall back to
 *   "price unavailable".
 * - `undefined` — ticker missing from the snapshot entirely (fetch
 *   failure / delisting); always render "price unavailable".
 */
type AssetPriceLookup = AssetPrice | NoSessionTrade | undefined;
type AssetWithName = { symbol: string; name: string };

export const NO_TRACKED_ASSETS_MESSAGE = "You don't have any tracked assets";

// Only allows http: and https: schemes to prevent javascript:, data:, and similar XSS.
export function getSafeHrefUrl(url: string): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	const trimmed = url.trim().toLowerCase();
	if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
		return url.trim();
	}
	return null;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatAssetPriceText(
	price: AssetPrice,
	sparkline?: SparklineData | null,
	showChangePercent = true,
): string {
	let base = `$${price.price.toFixed(2)}`;
	if (showChangePercent) {
		const sign = price.changePercent >= 0 ? "+" : "";
		base += ` (${sign}${price.changePercent.toFixed(2)}%)`;
	}
	if (sparkline?.ascii) {
		return `${base} ${SMS_SPARKLINE_LABEL[sparkline.window]}: ${sparkline.ascii}`;
	}
	return base;
}

/**
 * Plain-text label when a ticker has no live trade in the current session.
 *
 * Returns null when `marketSession` isn't pre/after — the caller should fall
 * back to the generic "price unavailable" string for regular/closed sessions
 * since the distinction only matters in extended-hours windows.
 */
function getNoSessionTradeText(
	symbol: string,
	marketSession: ActiveMarketSession | undefined,
): string | null {
	if (marketSession === "pre") return `${symbol} — no pre-market trades`;
	if (marketSession === "after") return `${symbol} — no after-hours trades`;
	return null;
}

/** Format a single asset line for plaintext contexts (email text / SMS / previews). */
export function formatAssetTextLine(
	asset: AssetWithName,
	price: AssetPriceLookup,
	sparkline?: SparklineData | null,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	if (price === "no_session_trade") {
		const label = getNoSessionTradeText(asset.symbol, marketSession);
		if (label) return label;
		return `${asset.symbol} — price unavailable`;
	}
	if (!price) {
		return `${asset.symbol} — price unavailable`;
	}
	return `${asset.symbol} — ${formatAssetPriceText(price, sparkline, showChangePercent)}`;
}

// WCAG 2.1 AA 4.5:1 on light bg.
export function getChangeColor(changePercent: number): string {
	return changePercent >= 0 ? "#166534" : "#b91c1c";
}

export function formatAssetHtmlLine(
	asset: AssetWithName,
	price: AssetPriceLookup,
	sparkline?: SparklineData | null,
	logoHtml?: string,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	const assetInfo = `${logoHtml ?? ""}${escapeHtml(asset.symbol)}`;

	if (price === "no_session_trade") {
		const sessionLabel =
			marketSession === "pre"
				? "no pre-market trades"
				: marketSession === "after"
					? "no after-hours trades"
					: "price unavailable";
		return `<strong>${assetInfo}</strong> &mdash; <span style="color: #6b7280;">${sessionLabel}</span>`;
	}
	if (!price) {
		return `<strong>${assetInfo}</strong> &mdash; <span style="color: #6b7280;">price unavailable</span>`;
	}

	const priceStr = escapeHtml(`$${price.price.toFixed(2)}`);
	const color = getChangeColor(price.changePercent);

	let changeHtml = "";
	if (showChangePercent) {
		const sign = price.changePercent >= 0 ? "+" : "";
		const changeStr = escapeHtml(`(${sign}${price.changePercent.toFixed(2)}%)`);
		changeHtml = ` <span style="color: ${color};">${changeStr}</span>`;
	}

	let sparklineHtml = "";
	if (sparkline?.values && sparkline.values.length >= 2) {
		const label = EMAIL_SPARKLINE_LABEL[sparkline.window];
		const labelHtml = ` <span style="color: #6b7280; font-size: 11px; margin-left: 6px;">${escapeHtml(`${label}:`)}</span>`;
		const altText = `${label} price trend`;
		sparklineHtml = `${labelHtml} ${toSvgSparklineImg(sparkline.values, color, 120, 30, altText)}`;
	}

	return `<strong>${assetInfo}</strong> &mdash; ${priceStr}${changeHtml}${sparklineHtml}`;
}

export function formatAssetsTextList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPriceLookup,
	getSparkline?: (symbol: string) => SparklineData | null | undefined,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	if (assets.length === 0) {
		return NO_TRACKED_ASSETS_MESSAGE;
	}

	return assets
		.map((asset) =>
			formatAssetTextLine(
				asset,
				getPrice(asset.symbol),
				getSparkline?.(asset.symbol),
				showChangePercent,
				marketSession,
			),
		)
		.join("\n\n");
}

export function formatAssetsHtmlList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPriceLookup,
	context?: Pick<EmailFormatContext, "getSparkline" | "getLogoHtml"> & {
		showChangePercent?: boolean;
		marketSession?: ActiveMarketSession;
	},
): string {
	if (assets.length === 0) {
		return escapeHtml(NO_TRACKED_ASSETS_MESSAGE);
	}

	const showChange = context?.showChangePercent ?? true;
	return assets
		.map((asset) =>
			formatAssetHtmlLine(
				asset,
				getPrice(asset.symbol),
				context?.getSparkline?.(asset.symbol),
				context?.getLogoHtml?.(asset.symbol),
				showChange,
				context?.marketSession,
			),
		)
		.join("<br>");
}
