import type { ActiveMarketSession, NoSessionTrade } from "../../types";
import { SMS_SPARKLINE_LABEL, type SparklineData } from "./sparkline";

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
export type AssetPriceLookup = AssetPrice | NoSessionTrade | undefined;
export type AssetWithName = { symbol: string; name: string };

export const NO_TRACKED_ASSETS_MESSAGE = "You don't have any tracked assets";

/** Canonical USD price rendering, shared across every channel: thousands separators +
 *  2 decimals ("$1,234.56"). Use everywhere a price is shown so SMS/email/Telegram/alerts
 *  never diverge on grouping. */
export function formatUsdPrice(price: number): string {
	return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Canonical signed change-percent rendering ("+1.23%" / "-4.50%"); `>= 0` gets a `+`.
 *  Caller adds any surrounding parens. 2 decimals fleet-wide. */
export function formatSignedChangePercent(changePercent: number): string {
	const sign = changePercent >= 0 ? "+" : "";
	return `${sign}${changePercent.toFixed(2)}%`;
}

function formatAssetPriceText(
	price: AssetPrice,
	sparkline?: SparklineData | null,
	showChangePercent = true,
): string {
	let base = formatUsdPrice(price.price);
	if (showChangePercent) {
		const changePercent = resolveDisplayChangePercent(price, sparkline);
		base += ` (${formatSignedChangePercent(changePercent)})`;
	}
	if (sparkline?.ascii) {
		const label = sparkline.cacheAsOfLabel ?? SMS_SPARKLINE_LABEL[sparkline.window];
		return `${base} ${label}: ${sparkline.ascii}`;
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

/** Net percent move from first to last sparkline point — matches chart shape. */
export function getSparklineDirectionPercent(values: number[]): number {
	if (values.length < 2) return 0;
	const first = values[0];
	const last = values[values.length - 1];
	if (first === undefined || last === undefined || first === 0) return 0;
	return ((last - first) / first) * 100;
}

/** Change % to show next to price — derived from the rendered sparkline's own
 *  endpoints whenever a chart is shown, so the headline % and the chart can
 *  never disagree on direction (the chart color uses the same computation).
 *  Vendor change fields update on a different cadence than the prices we
 *  chart; near-flat days they flip sign against each other (LDOS 2026-06-11:
 *  Massive todaysChangePerc -0.06% vs prev-close-anchored chart +0.45%).
 *  Without a sparkline, falls back to the quote's change-%. */
export function resolveDisplayChangePercent(
	price: AssetPrice,
	sparkline?: SparklineData | null,
): number {
	if (sparkline && sparkline.values.length >= 2) {
		return getSparklineDirectionPercent(sparkline.values);
	}
	return price.changePercent;
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
