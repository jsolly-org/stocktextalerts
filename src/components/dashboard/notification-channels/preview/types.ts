/** Demo asset shape used by the notification preview panel. */
export interface PreviewAsset {
	symbol: string;
	name: string;
	price: number;
	changePercent: number;
	sparkline?: string;
	sparklineValues?: number[];
}

/** One Telegram "Price Update" line, mirroring appendTelegramAssetPriceLines. */
export interface PreviewTelegramLine {
	dot: string;
	symbol: string;
	price: string;
	change: string;
}

/** A preview price alert: real candlestick SVG + caption pieces. */
export interface PreviewAlert {
	symbol: string;
	svgDataUri: string;
	priceContext: string;
}
