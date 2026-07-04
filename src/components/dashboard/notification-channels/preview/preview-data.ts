import {
	type AssetPrice,
	formatSignedChangePercent,
	formatUsdPrice,
	resolveDisplayChangePercent,
} from "../../../../lib/messaging/parts/asset-price-list";
import { renderPriceAlertHeadline } from "../../../../lib/messaging/parts/price-alert-sentences";
import type { SparklineData } from "../../../../lib/messaging/parts/sparkline";
import { buildCandlestickSvg } from "../../../../lib/messaging/telegram/candlestick";
import { directionDot } from "../../../../lib/messaging/telegram/direction-dot";
import type { IntradayCandle } from "../../../../lib/types";
import type { PreviewAlert, PreviewAsset, PreviewTelegramLine } from "./types";

/** Stable demo assets used to render previews without a live API call. */
export const DEMO_ASSETS: PreviewAsset[] = [
	{
		symbol: "AAPL",
		name: "Apple Inc",
		price: 195.5,
		// Matches the sparkline's first→last delta ((195−188)/188), which is what
		// the preview actually displays via resolveDisplayChangePercent.
		changePercent: 3.72,
		sparkline: "▁▂▃▅▇▅▆",
		sparklineValues: [188, 190, 191, 193, 196, 194, 195],
	},
	{
		symbol: "GOOGL",
		name: "Alphabet Inc",
		price: 178.2,
		// (178−174)/174
		changePercent: 2.3,
		sparkline: "▃▂▁▃▅▆▇",
		sparklineValues: [174, 173, 172, 174, 176, 177, 178],
	},
	{
		symbol: "TSLA",
		name: "Tesla Inc",
		price: 248.3,
		// (248−255)/255
		changePercent: -2.75,
		sparkline: "▇▆▅▃▂▃▁",
		sparklineValues: [255, 253, 252, 250, 249, 250, 248],
	},
];

function toSparklineData(asset: PreviewAsset): SparklineData | null {
	return asset.sparkline && asset.sparklineValues
		? { ascii: asset.sparkline, values: asset.sparklineValues, window: "7-trading-days" }
		: null;
}

/**
 * Build the per-asset lines of a Telegram "📈 Price Update" message using the
 * SAME pure helpers the production renderer uses (appendTelegramAssetPriceLines
 * in asset-price-list.ts: direction dot, bold ticker, price, signed change) —
 * so the preview can't drift from what a real Telegram delivery looks like.
 */
export function buildPreviewTelegramLines(assets: PreviewAsset[]): PreviewTelegramLine[] {
	return assets.map((asset) => {
		const quote: AssetPrice = { price: asset.price, changePercent: asset.changePercent };
		const changePercent = resolveDisplayChangePercent(quote, toSparklineData(asset));
		return {
			dot: directionDot(changePercent),
			symbol: asset.symbol,
			price: formatUsdPrice(asset.price),
			change: formatSignedChangePercent(changePercent),
		};
	});
}

/**
 * Build a preview price alert: the REAL candlestick SVG from buildCandlestickSvg —
 * the exact SVG production rasterizes to PNG for `sendPhoto` — rendered natively
 * by the browser via a data URI. Daily closes stand in for intraday bars (the
 * preview has no intraday feed; the visual grammar is identical).
 */
export function buildPreviewAlert(asset: PreviewAsset): PreviewAlert | null {
	const values = asset.sparklineValues;
	if (!values || values.length < 3) return null;
	const first = values[0];
	if (first === undefined) return null;

	const candles: IntradayCandle[] = [];
	let prev = first;
	for (const [i, c] of values.slice(1).entries()) {
		const pad = Math.abs(c - prev) * 0.35 + first * 0.001;
		candles.push({
			o: prev,
			c,
			h: Math.max(prev, c) + pad,
			l: Math.min(prev, c) - pad,
			// Timestamps are unused by the SVG builder's layout; index spacing is enough.
			t: i,
		});
		prev = c;
	}

	const svg = buildCandlestickSvg(candles, {
		prevClose: first,
		timeLabels: [
			{ position: 0, label: "9:30 AM" },
			{ position: 0.5, label: "12:45 PM" },
			{ position: 1, label: "4:00 PM" },
		],
	});
	if (svg === "") return null;

	const quote: AssetPrice = { price: asset.price, changePercent: asset.changePercent };
	const changePercent = resolveDisplayChangePercent(quote, toSparklineData(asset));
	return {
		symbol: asset.symbol,
		svgDataUri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
		// The canonical alert headline — the same sentence production Telegram alerts carry.
		headline: renderPriceAlertHeadline({
			symbol: asset.symbol,
			changePercent,
			price: asset.price,
			period: "today",
		}),
	};
}
