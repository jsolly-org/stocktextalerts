export interface PreviewAsset {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
	sparkline?: string;
}

import {
	type AssetPrice,
	formatAssetsHtmlList,
	formatAssetsTextList,
	formatAssetTextLine,
} from "../../../../lib/messaging/asset-formatting";
import type { FormatPreferences } from "../../../../lib/messaging/types";

export const DEMO_ASSETS: PreviewAsset[] = [
	{
		symbol: "AAPL",
		name: "Apple Inc",
		price: 195.5,
		changePercent: 2.4,
		sparkline: "▁▂▃▅▇▅▆",
	},
	{
		symbol: "GOOGL",
		name: "Alphabet Inc",
		price: 178.2,
		changePercent: 1.8,
		sparkline: "▃▂▁▃▅▆▇",
	},
	{
		symbol: "TSLA",
		name: "Tesla Inc",
		price: 248.3,
		changePercent: -0.5,
		sparkline: "▇▆▅▃▂▃▁",
	},
];

/**
 * Format a single demo asset line for the notification preview UI.
 */
export function formatPreviewLine(
	asset: PreviewAsset,
	prefs: FormatPreferences,
): string {
	return formatAssetTextLine(
		asset,
		{ price: asset.price, changePercent: asset.changePercent },
		prefs,
		asset.sparkline,
	);
}

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
 */
export function formatPreviewEmailHtml(
	assets: PreviewAsset[],
	prefs: FormatPreferences,
): string {
	if (assets.length === 0) {
		return '<p style="color: #4b5563;">You don\'t have any tracked assets yet.</p>';
	}

	const prices = new Map<string, AssetPrice>(
		assets.map((asset) => [
			asset.symbol,
			{ price: asset.price, changePercent: asset.changePercent },
		]),
	);
	const sparklines = new Map<string, string | null>(
		assets.map((asset) => [asset.symbol, asset.sparkline ?? null]),
	);
	return formatAssetsHtmlList(
		assets,
		(symbol) => prices.get(symbol),
		prefs,
		(symbol) => sparklines.get(symbol),
	);
}
