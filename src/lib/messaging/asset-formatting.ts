import type { FormatPreferences } from "./types";

/** Price quote subset required for rendering asset lines. */
export type AssetPrice = { price: number; changePercent: number };
type AssetWithName = { symbol: string; name: string };

/** User-facing fallback shown when no assets are tracked. */
export const NO_TRACKED_ASSETS_MESSAGE = "You don't have any tracked assets";

/**
 * Escape a string for safe HTML embedding.
 */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatAssetBaseText(
	asset: AssetWithName,
	formatPrefs: FormatPreferences,
): string {
	return formatPrefs.show_company_name
		? `${asset.symbol} - ${asset.name}`
		: asset.symbol;
}

function formatAssetPriceText(
	price: AssetPrice,
	sparkline?: string | null,
): string {
	const sign = price.changePercent >= 0 ? "+" : "";
	const base = `$${price.price.toFixed(2)} (${sign}${price.changePercent.toFixed(2)}%)`;
	if (sparkline) {
		return `${base} ${sparkline}`;
	}
	return base;
}

/**
 * Format a single asset line for plaintext contexts (email text / SMS / previews).
 */
export function formatAssetTextLine(
	asset: AssetWithName,
	price: AssetPrice | undefined,
	formatPrefs: FormatPreferences,
	sparkline?: string | null,
): string {
	const base = formatAssetBaseText(asset, formatPrefs);
	if (!price) {
		return base;
	}
	const effectiveSparkline = formatPrefs.show_sparklines ? sparkline : null;
	return `${base} — ${formatAssetPriceText(price, effectiveSparkline)}`;
}

function getChangeColor(changePercent: number): string {
	return changePercent >= 0 ? "#15803d" : "#dc2626";
}

function formatAssetHtmlLine(
	asset: AssetWithName,
	price: AssetPrice | undefined,
	formatPrefs: FormatPreferences,
	sparkline?: string | null,
): string {
	const assetInfo = formatPrefs.show_company_name
		? escapeHtml(`${asset.symbol} - ${asset.name}`)
		: escapeHtml(asset.symbol);

	if (!price) {
		return assetInfo;
	}

	const priceStr = escapeHtml(`$${price.price.toFixed(2)}`);
	const sign = price.changePercent >= 0 ? "+" : "";
	const color = getChangeColor(price.changePercent);
	const changeStr = escapeHtml(`(${sign}${price.changePercent.toFixed(2)}%)`);

	const effectiveSparkline = formatPrefs.show_sparklines ? sparkline : null;
	const sparklineHtml = effectiveSparkline
		? ` <span style="letter-spacing:1px">${escapeHtml(effectiveSparkline)}</span>`
		: "";

	return `${assetInfo} &mdash; ${priceStr} <span style="color: ${color};">${changeStr}</span>${sparklineHtml}`;
}

/**
 * Format a list of assets as plaintext, using the user's formatting preferences.
 */
export function formatAssetsTextList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	formatPrefs: FormatPreferences,
	getSparkline?: (symbol: string) => string | null | undefined,
): string {
	if (assets.length === 0) {
		return NO_TRACKED_ASSETS_MESSAGE;
	}

	const separator = formatPrefs.detailed_format ? "\n\n" : "\n";
	return assets
		.map((asset) =>
			formatAssetTextLine(
				asset,
				getPrice(asset.symbol),
				formatPrefs,
				getSparkline?.(asset.symbol),
			),
		)
		.join(separator);
}

/**
 * Format a list of assets as HTML, using the user's formatting preferences.
 */
export function formatAssetsHtmlList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	formatPrefs: FormatPreferences,
	getSparkline?: (symbol: string) => string | null | undefined,
): string {
	if (assets.length === 0) {
		return escapeHtml(NO_TRACKED_ASSETS_MESSAGE);
	}

	const joinStr = formatPrefs.detailed_format ? "<br><br>" : "<br>";
	return assets
		.map((asset) =>
			formatAssetHtmlLine(
				asset,
				getPrice(asset.symbol),
				formatPrefs,
				getSparkline?.(asset.symbol),
			),
		)
		.join(joinStr);
}
