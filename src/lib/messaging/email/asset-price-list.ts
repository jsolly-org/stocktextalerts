import type { ActiveMarketSession } from "../../types";
import {
	type AssetPriceLookup,
	type AssetWithName,
	formatSignedChangePercent,
	formatUsdPrice,
	getChangeColor,
	getSparklineDirectionPercent,
	NO_TRACKED_ASSETS_MESSAGE,
	resolveDisplayChangePercent,
} from "../parts/asset-price-list";
import { escapeHtml } from "../parts/html-utils";
import { EMAIL_SPARKLINE_LABEL, type SparklineData } from "../parts/sparkline";
import type { EmailFormatContext } from "../types";
import { toSvgSparklineImg } from "./svg-sparkline";

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
