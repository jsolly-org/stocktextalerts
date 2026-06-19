import { Resvg } from "@resvg/resvg-js";
import { escapeHtml } from "../asset-formatting";

/** A single intraday OHLC bar. `t` is ms since epoch. */
export interface Candle {
	o: number;
	h: number;
	l: number;
	c: number;
	t: number;
}

/** A time label rendered on the x-axis (position is a 0–1 fraction across the plot). */
export interface ChartTimeLabel {
	position: number;
	label: string;
}

export interface CandlestickChartOptions {
	/** Logical SVG width in px (rendered at 2× for crispness). */
	width?: number;
	/** Logical SVG height in px. */
	height?: number;
	/** Prior close — drawn as a dashed reference line when provided. */
	prevClose?: number;
	/** Up to ~3 time labels for the x-axis (e.g. open / midday / now). */
	timeLabels?: ChartTimeLabel[];
	/** Candle color when close ≥ open. */
	upColor?: string;
	/** Candle color when close < open. */
	downColor?: string;
}

const DEFAULTS = {
	width: 800,
	height: 400,
	upColor: "#1d9e75",
	downColor: "#e24b4a",
	bg: "#ffffff",
	grid: "#eceff3",
	axisText: "#9ca3af",
	refLine: "#9ca3af",
	renderScale: 2,
} as const;

const PAD = { top: 14, right: 58, bottom: 24, left: 10 } as const;

/** Format a price for an axis label (2 decimals, thousands-separated). */
function formatPrice(value: number): string {
	return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Build a candlestick chart as a raw SVG string (no `<img>` wrapper), suitable for
 * rasterizing to PNG via {@link renderChartPng} for Telegram `sendPhoto`.
 *
 * Distinct from `toSvgSparklineImg` (which targets inline email and is pinned by tests):
 * this returns standalone SVG with a solid background so it reads on both Telegram themes.
 * Returns "" for fewer than 2 candles.
 */
export function buildCandlestickSvg(
	candles: Candle[],
	options: CandlestickChartOptions = {},
): string {
	if (candles.length < 2) return "";

	const width = options.width ?? DEFAULTS.width;
	const height = options.height ?? DEFAULTS.height;
	const upColor = options.upColor ?? DEFAULTS.upColor;
	const downColor = options.downColor ?? DEFAULTS.downColor;

	const plotLeft = PAD.left;
	const plotTop = PAD.top;
	const plotW = width - PAD.left - PAD.right;
	const plotH = height - PAD.top - PAD.bottom;
	const plotBottom = plotTop + plotH;

	// Price domain: candle extremes plus the optional reference, padded 4% each side.
	let lo = Math.min(...candles.map((b) => b.l));
	let hi = Math.max(...candles.map((b) => b.h));
	if (options.prevClose !== undefined && Number.isFinite(options.prevClose)) {
		lo = Math.min(lo, options.prevClose);
		hi = Math.max(hi, options.prevClose);
	}
	const span = hi - lo || Math.abs(hi) || 1;
	lo -= span * 0.04;
	hi += span * 0.04;
	const priceToY = (p: number) => plotTop + (1 - (p - lo) / (hi - lo)) * plotH;

	const slot = plotW / candles.length;
	const bodyW = Math.max(1, slot * 0.66);

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${DEFAULTS.bg}"/>`,
	];

	// Horizontal gridlines + right-aligned price labels (5 evenly spaced levels).
	const gridCount = 4;
	for (let i = 0; i <= gridCount; i++) {
		const price = lo + ((hi - lo) * i) / gridCount;
		const y = priceToY(price);
		parts.push(
			`<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${(plotLeft + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${DEFAULTS.grid}" stroke-width="1"/>`,
			`<text x="${(plotLeft + plotW + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-family="sans-serif" font-size="11" fill="${DEFAULTS.axisText}" text-anchor="start">${escapeHtml(formatPrice(price))}</text>`,
		);
	}

	// Prior-close reference line (dashed).
	if (options.prevClose !== undefined && Number.isFinite(options.prevClose)) {
		const y = priceToY(options.prevClose);
		parts.push(
			`<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${(plotLeft + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${DEFAULTS.refLine}" stroke-width="1" stroke-dasharray="4 3"/>`,
		);
	}

	// Candles: wick (high→low) + body (open→close), colored by direction.
	for (let i = 0; i < candles.length; i++) {
		const bar = candles[i];
		if (!bar) continue;
		const color = bar.c >= bar.o ? upColor : downColor;
		const centerX = plotLeft + (i + 0.5) * slot;
		const yHigh = priceToY(bar.h);
		const yLow = priceToY(bar.l);
		const yTop = priceToY(Math.max(bar.o, bar.c));
		const yBottom = priceToY(Math.min(bar.o, bar.c));
		const bodyH = Math.max(1, yBottom - yTop);
		parts.push(
			`<line x1="${centerX.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${centerX.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/>`,
			`<rect x="${(centerX - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`,
		);
	}

	// Time-axis labels.
	if (options.timeLabels && options.timeLabels.length > 0) {
		for (let i = 0; i < options.timeLabels.length; i++) {
			const tl = options.timeLabels[i];
			if (!tl) continue;
			const x = plotLeft + Math.max(0, Math.min(1, tl.position)) * plotW;
			const anchor = i === 0 ? "start" : i === options.timeLabels.length - 1 ? "end" : "middle";
			parts.push(
				`<text x="${x.toFixed(1)}" y="${(plotBottom + 16).toFixed(1)}" font-family="sans-serif" font-size="11" fill="${DEFAULTS.axisText}" text-anchor="${anchor}">${escapeHtml(tl.label)}</text>`,
			);
		}
	}

	parts.push("</svg>");
	return parts.join("");
}

/**
 * Rasterize an SVG string to a PNG buffer via resvg.
 *
 * Returns `null` on failure so the caller can degrade gracefully to a text-only
 * message rather than dropping the notification. Renders at {@link DEFAULTS.renderScale}×
 * the logical width for crisp display on high-DPI screens.
 */
export function renderChartPng(svg: string): Buffer | null {
	if (svg === "") return null;
	const widthMatch = svg.match(/width="(\d+)"/);
	const targetWidth = widthMatch?.[1]
		? Number.parseInt(widthMatch[1], 10) * DEFAULTS.renderScale
		: DEFAULTS.width * DEFAULTS.renderScale;
	try {
		const png = new Resvg(svg, {
			fitTo: { mode: "width", value: targetWidth },
		})
			.render()
			.asPng();
		return Buffer.from(png);
	} catch {
		return null;
	}
}
