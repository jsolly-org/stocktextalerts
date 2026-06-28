import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { AssetPriceMap, NoSessionTrade } from "../../market-data/types";
import type { EmailFormatContext } from "../types";
import { EMAIL_SPARKLINE_LABEL, SMS_SPARKLINE_LABEL, type SparklineData } from "./charts/sparkline";
import { toSvgSparklineImg } from "./charts/svg-sparkline";
import { escapeHtml, getSafeHrefUrl } from "./html-utils";
import type { ActiveMarketSession } from "./session-label";

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

export { escapeHtml, getSafeHrefUrl };

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

const UP = "🟢";
const DOWN = "🔴";
const FLAT = "⚪️";

function directionDot(changePercent: number): string {
	return changePercent > 0 ? UP : changePercent < 0 ? DOWN : FLAT;
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
function getSparklineDirectionPercent(values: number[]): number {
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
function resolveDisplayChangePercent(price: AssetPrice, sparkline?: SparklineData | null): number {
	if (sparkline && sparkline.values.length >= 2) {
		return getSparklineDirectionPercent(sparkline.values);
	}
	return price.changePercent;
}

// Base cell style: no `white-space: nowrap` so individual cells can shrink on
// narrow mobile viewports. Cells that must stay on one line (ticker, price,
// change%) opt back into nowrap explicitly via NOWRAP_CELL / NUM_CELL.
const ROW_CELL = "padding: 4px 0; vertical-align: middle;";
const NOWRAP_CELL = `${ROW_CELL} white-space: nowrap;`;
const NUM_CELL = `${NOWRAP_CELL} font-variant-numeric: tabular-nums;`;
const ROW_DIVIDER = "border-bottom: 1px solid #e5e7eb;";
const ASSET_ROW_COLS = 5;

export function formatAssetHtmlLine(
	asset: AssetWithName,
	price: AssetPriceLookup,
	sparkline?: SparklineData | null,
	logoHtml?: string,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	const symbol = escapeHtml(asset.symbol);

	if (price === "no_session_trade" || !price) {
		const label =
			price === "no_session_trade" && marketSession === "pre"
				? "no pre-market trades"
				: price === "no_session_trade" && marketSession === "after"
					? "no after-hours trades"
					: "price unavailable";
		const labelSpan = ASSET_ROW_COLS - 3;
		const logo = `<td style="${NOWRAP_CELL} padding-right: 4px; ${ROW_DIVIDER}">${logoHtml ?? ""}</td>`;
		const ticker = `<td style="${NOWRAP_CELL} font-weight: 700; ${ROW_DIVIDER}">${symbol}</td>`;
		const dash = `<td style="${NOWRAP_CELL} padding: 4px 8px; ${ROW_DIVIDER}">&mdash;</td>`;
		const labelCell = `<td colspan="${labelSpan}" style="${ROW_CELL} color: #6b7280; ${ROW_DIVIDER}">${label}</td>`;
		return `<tr>${logo}${ticker}${dash}${labelCell}</tr>`;
	}

	const priceStr = escapeHtml(formatUsdPrice(price.price));
	const displayChangePercent = resolveDisplayChangePercent(price, sparkline);
	const displayColor = getChangeColor(displayChangePercent);

	const hasSparkline = !!(sparkline?.values && sparkline.values.length >= 2);
	const priceRowDivider = hasSparkline ? "" : ROW_DIVIDER;

	const logoCell = `<td style="${NOWRAP_CELL} padding-right: 4px; ${priceRowDivider}">${logoHtml ?? ""}</td>`;
	const tickerCell = `<td style="${NOWRAP_CELL} font-weight: 700; ${priceRowDivider}">${symbol}</td>`;
	const dashCell = `<td style="${NOWRAP_CELL} padding: 4px 8px; ${priceRowDivider}">&mdash;</td>`;
	const priceCell = `<td style="${NUM_CELL} font-weight: 700; ${priceRowDivider}">${priceStr}</td>`;

	let changeCell = `<td style="${ROW_CELL} ${priceRowDivider}"></td>`;
	if (showChangePercent) {
		const changeStr = escapeHtml(`(${formatSignedChangePercent(displayChangePercent)})`);
		changeCell = `<td style="${NUM_CELL} padding-left: 8px; color: ${displayColor}; ${priceRowDivider}">${changeStr}</td>`;
	}

	const priceRow = `<tr>${logoCell}${tickerCell}${dashCell}${priceCell}${changeCell}</tr>`;

	if (!hasSparkline) {
		return priceRow;
	}

	const label = sparkline.cacheAsOfLabel ?? EMAIL_SPARKLINE_LABEL[sparkline.window];
	const altText = `${label} price trend`;
	const trendLabel = `<span style="color: #6b7280; font-size: 11px; padding-right: 6px;">${escapeHtml(`${label}:`)}</span>`;
	const sparklineColor = getChangeColor(getSparklineDirectionPercent(sparkline.values));
	const trendImg = toSvgSparklineImg(sparkline.values, sparklineColor, 120, 30, altText);
	const trendSpan = ASSET_ROW_COLS - 2;
	const trendEmpty = `<td style="${ROW_CELL} ${ROW_DIVIDER}"></td>`;
	const trendCell = `<td colspan="${trendSpan}" style="padding: 0 0 8px 0; vertical-align: middle; ${ROW_DIVIDER}">${trendLabel}${trendImg}</td>`;
	const trendRow = `<tr>${trendEmpty}${trendEmpty}${trendCell}</tr>`;

	return priceRow + trendRow;
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
		getShowChangePercent?: (symbol: string) => boolean;
		marketSession?: ActiveMarketSession;
	},
): string {
	if (assets.length === 0) {
		return escapeHtml(NO_TRACKED_ASSETS_MESSAGE);
	}

	const defaultShowChange = context?.showChangePercent ?? true;
	const rows = assets
		.map((asset) => {
			const showChange = context?.getShowChangePercent?.(asset.symbol) ?? defaultShowChange;
			return formatAssetHtmlLine(
				asset,
				getPrice(asset.symbol),
				context?.getSparkline?.(asset.symbol),
				context?.getLogoHtml?.(asset.symbol),
				showChange,
				context?.marketSession,
			);
		})
		.join("");

	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; max-width: 100%;">${rows}</table>`;
}

/** Append Telegram-native asset price lines to an existing FormattedString message. */
export function appendTelegramAssetPriceLines(options: {
	msg: FormattedString;
	userAssets: Array<{ symbol: string }>;
	assetPrices: AssetPriceMap;
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	showChangePercent?: (symbol: string) => boolean;
}): FormattedString {
	let { msg } = options;
	for (const asset of options.userAssets) {
		const quote = options.assetPrices.get(asset.symbol);
		if (!quote) {
			msg = fmt`${msg}\n${asset.symbol} — price unavailable`;
			continue;
		}
		const sparkline = options.getSparkline?.(asset.symbol);
		const showChange = options.showChangePercent?.(asset.symbol) ?? true;
		const changePercent =
			showChange && quote
				? resolveDisplayChangePercent(quote, sparkline ?? null)
				: quote.changePercent;
		const dot = directionDot(changePercent);
		const changeSuffix = showChange ? `  (${formatSignedChangePercent(changePercent)})` : "";
		msg = fmt`${msg}\n${dot} ${FormattedString.bold(asset.symbol)}  ${formatUsdPrice(quote.price)}${changeSuffix}`;
	}
	return msg;
}
