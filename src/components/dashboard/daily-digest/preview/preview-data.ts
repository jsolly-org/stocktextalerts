/** Demo asset shape used by the daily-digest preview panel. */
export interface PreviewAsset {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
	sparkline?: string;
	sparklineValues?: number[];
}

import {
	type AssetPrice,
	escapeHtml,
	formatAssetsTextList,
	getChangeColor,
} from "../../../../lib/messaging/asset-formatting";
import { toSvgSparklineImg } from "../../../../lib/messaging/svg-sparkline";
import type { FormatPreferences } from "../../../../lib/messaging/types";

/** Stable demo assets used to render previews without a live API call. */
export const DEMO_ASSETS: PreviewAsset[] = [
	{
		symbol: "AAPL",
		name: "Apple Inc",
		price: 195.5,
		changePercent: 2.4,
		sparkline: "▁▂▃▅▇▅▆",
		sparklineValues: [188, 190, 191, 193, 196, 194, 195],
	},
	{
		symbol: "GOOGL",
		name: "Alphabet Inc",
		price: 178.2,
		changePercent: 1.8,
		sparkline: "▃▂▁▃▅▆▇",
		sparklineValues: [174, 173, 172, 174, 176, 177, 178],
	},
	{
		symbol: "TSLA",
		name: "Tesla Inc",
		price: 248.3,
		changePercent: -0.5,
		sparkline: "▇▆▅▃▂▃▁",
		sparklineValues: [255, 253, 252, 250, 249, 250, 248],
	},
];

/**
 * Format a plaintext preview list for a set of demo assets.
 */
export function formatPreviewAssetsList(
	assets: PreviewAsset[],
	prefs: FormatPreferences,
): string {
	const prices = new Map<string, AssetPrice>(
		assets.map((asset) => [
			asset.symbol,
			{ price: asset.price, changePercent: asset.changePercent },
		]),
	);
	const sparklines = new Map<string, string | null>(
		assets.map((asset) => [asset.symbol, asset.sparkline ?? null]),
	);
	return formatAssetsTextList(
		assets,
		(symbol) => prices.get(symbol),
		prefs,
		(symbol) => sparklines.get(symbol),
	);
}

/**
 * Format an HTML preview block for a set of demo assets (email-like rendering).
 *
 * Uses SVG sparklines and colored change percentages to match the actual
 * daily digest email output.
 */
export function formatPreviewEmailHtml(
	assets: PreviewAsset[],
	prefs: FormatPreferences,
): string {
	if (assets.length === 0) {
		return '<p style="color: #4b5563;">You don\'t have any tracked assets yet.</p>';
	}

	return assets
		.map((asset) => {
			const symbol = escapeHtml(asset.symbol);
			const priceStr = escapeHtml(`$${asset.price.toFixed(2)}`);
			const sign = asset.changePercent >= 0 ? "+" : "";
			const color = getChangeColor(asset.changePercent);
			const changeStr = escapeHtml(
				`(${sign}${asset.changePercent.toFixed(2)}%)`,
			);

			let sparklineHtml = "";
			if (
				prefs.show_sparklines &&
				asset.sparklineValues &&
				asset.sparklineValues.length >= 2
			) {
				sparklineHtml = ` ${toSvgSparklineImg(asset.sparklineValues, color)}`;
			}

			/* color: #374151 meets WCAG 2.1 AA 4.5:1 on light bg */
			return `<div style="margin-bottom: 8px; color: #374151;">${symbol} &mdash; ${priceStr} <span style="color: ${color}; font-weight: 600;">${changeStr}</span>${sparklineHtml}</div>`;
		})
		.join("");
}
