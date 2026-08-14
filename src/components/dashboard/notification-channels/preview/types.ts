/** Channels that render a delivery-pipe preview. Disabled hides it. */
export type NotificationPreviewChannel = "email" | "telegram";

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
	/** Rendered headline sentence (the Telegram channel's, which this panel previews). */
	headline: string;
}

/** One scheduled-price email row, mirroring formatAssetHtmlLine. */
export interface PreviewEmailRow {
	symbol: string;
	price: string;
	change: string;
	changeColor: string;
	sparklineSrc: string | null;
	sparklineLabel: string;
}
