import type { SparklineData } from "./sparkline";
import { toSvgSparklineImg } from "./svg-sparkline";
import type { EmailFormatContext } from "./types";

export type AssetPrice = { price: number; changePercent: number };
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
	sparkline?: string | null,
): string {
	if (!price) {
		return `${asset.symbol} — price unavailable`;
	}
	return `${asset.symbol} — ${formatAssetPriceText(price, sparkline)}`;
}

// WCAG 2.1 AA 4.5:1 on light bg.
export function getChangeColor(changePercent: number): string {
	return changePercent >= 0 ? "#166534" : "#b91c1c";
}

export function formatAssetHtmlLine(
	asset: AssetWithName,
	price: AssetPrice | undefined,
	sparkline?: SparklineData | null,
	logoHtml?: string,
): string {
	const assetInfo = `${logoHtml ?? ""}${escapeHtml(asset.symbol)}`;

	if (!price) {
		return `<strong>${assetInfo}</strong> &mdash; <span style="color: #6b7280;">price unavailable</span>`;
	}

	const priceStr = escapeHtml(`$${price.price.toFixed(2)}`);
	const sign = price.changePercent >= 0 ? "+" : "";
	const color = getChangeColor(price.changePercent);
	const changeStr = escapeHtml(`(${sign}${price.changePercent.toFixed(2)}%)`);

	let sparklineHtml = "";
	if (sparkline?.values && sparkline.values.length >= 2) {
		sparklineHtml = ` ${toSvgSparklineImg(sparkline.values, color)}`;
	}

	return `<strong>${assetInfo}</strong> &mdash; ${priceStr} <span style="color: ${color};">${changeStr}</span>${sparklineHtml}`;
}

export function formatAssetsTextList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	getSparkline?: (symbol: string) => string | null | undefined,
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
			),
		)
		.join("\n\n");
}

export function formatAssetsHtmlList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	context?: Pick<EmailFormatContext, "getSparkline" | "getLogoHtml">,
): string {
	if (assets.length === 0) {
		return escapeHtml(NO_TRACKED_ASSETS_MESSAGE);
	}

	return assets
		.map((asset) =>
			formatAssetHtmlLine(
				asset,
				getPrice(asset.symbol),
				context?.getSparkline?.(asset.symbol),
				context?.getLogoHtml?.(asset.symbol),
			),
		)
		.join("<br>");
}
