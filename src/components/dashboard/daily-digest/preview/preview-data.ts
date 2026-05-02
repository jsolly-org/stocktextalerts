/** Demo asset shape used by the daily-digest preview panel. */
export interface PreviewAsset {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
	sparkline?: string;
	sparklineValues?: number[];
}

import { type AssetPrice, formatAssetsTextList } from "../../../../lib/messaging/asset-formatting";

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
export function formatPreviewAssetsList(assets: PreviewAsset[]): string {
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
		(symbol) => sparklines.get(symbol),
	);
}
