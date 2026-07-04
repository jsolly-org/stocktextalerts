import type { IntradayCandle } from "../../types";
import { escapeHtml } from "../parts/html-utils";

/** Logical chart width in px — the PNG rasterizer (render-png.ts) scales from this. */
export const CHART_DEFAULT_WIDTH = 800;

/** A time label rendered on the x-axis (position is a 0–1 fraction across the plot). */
interface ChartTimeLabel {
	position: number;
	label: string;
}

interface CandlestickChartOptions {
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
	width: CHART_DEFAULT_WIDTH,
	height: 400,
	upColor: "#1d9e75",
	downColor: "#e24b4a",
	bg: "#ffffff",
	grid: "#eceff3",
	axisText: "#6b7280",
	refLine: "#9ca3af",
	fontFamily: "Roboto, sans-serif",
} as const;

const PAD = { top: 14, right: 58, bottom: 24, left: 10 } as const;

/** Format a price for an axis label (2 decimals, thousands-separated). */
function formatPrice(value: number): string {
	return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Build a candlestick chart as a raw SVG string (no `<img>` wrapper), suitable for
 * rasterizing to PNG for Telegram `sendPhoto` (render-png.ts — Node/Lambda only;
 * browsers render this SVG directly, e.g. the dashboard notification preview).
 *
 * Design (see docs/plans/2026-07-03-beautiful-telegram-notifications.md):
 * - Rising bodies are HOLLOW (background fill, colored stroke), falling bodies solid —
 *   the classic hollow/filled convention. Direction stays readable in grayscale, so the
 *   chart never relies on red/green hue alone (~8% of men can't distinguish that pair).
 * - The last close gets a dotted track line plus a price tag in the right gutter,
 *   colored by the day's direction (vs. prevClose when available).
 *
 * Distinct from `toSvgSparklineImg` (which targets inline email and is pinned by tests):
 * this returns standalone SVG with a solid background so it reads on both Telegram themes.
 * Returns "" for fewer than 2 candles.
 */
export function buildCandlestickSvg(
	candles: IntradayCandle[],
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
	const plotRight = plotLeft + plotW;

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
			`<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${DEFAULTS.grid}" stroke-width="1"/>`,
			`<text x="${(plotRight + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-family="${DEFAULTS.fontFamily}" font-size="11" fill="${DEFAULTS.axisText}" text-anchor="start">${escapeHtml(formatPrice(price))}</text>`,
		);
	}

	// Prior-close reference line (dashed).
	if (options.prevClose !== undefined && Number.isFinite(options.prevClose)) {
		const y = priceToY(options.prevClose);
		parts.push(
			`<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${DEFAULTS.refLine}" stroke-width="1" stroke-dasharray="4 3"/>`,
		);
	}

	// Candles: wick (high→low) + body (open→close). Rising bodies hollow, falling solid
	// (see the doc comment above — direction must survive grayscale).
	for (let i = 0; i < candles.length; i++) {
		const bar = candles[i];
		if (!bar) continue;
		const rising = bar.c >= bar.o;
		const color = rising ? upColor : downColor;
		const centerX = plotLeft + (i + 0.5) * slot;
		const yHigh = priceToY(bar.h);
		const yLow = priceToY(bar.l);
		const yTop = priceToY(Math.max(bar.o, bar.c));
		const yBottom = priceToY(Math.min(bar.o, bar.c));
		const bodyH = Math.max(1, yBottom - yTop);
		const body = rising
			? `<rect x="${(centerX - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${DEFAULTS.bg}" stroke="${color}" stroke-width="1.5"/>`
			: `<rect x="${(centerX - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`;
		parts.push(
			`<line x1="${centerX.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${centerX.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/>`,
			body,
		);
	}

	// Last-close marker: a dotted track line across the plot plus a price tag in the
	// right gutter, both in the day's direction color (last close vs. prevClose when
	// provided, else vs. the first bar's open).
	const last = candles[candles.length - 1];
	if (last) {
		const anchor =
			options.prevClose !== undefined && Number.isFinite(options.prevClose)
				? options.prevClose
				: (candles[0]?.o ?? last.c);
		const dirColor = last.c >= anchor ? upColor : downColor;
		const lastY = priceToY(last.c);
		const tagW = PAD.right - 4;
		const tagH = 18;
		const tagX = plotRight + 2;
		const tagY = Math.min(Math.max(lastY - tagH / 2, 1), height - tagH - 1);
		parts.push(
			`<line x1="${plotLeft}" y1="${lastY.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="${dirColor}" stroke-width="1" stroke-dasharray="1 3" opacity="0.55"/>`,
			`<rect x="${tagX.toFixed(1)}" y="${tagY.toFixed(1)}" width="${tagW}" height="${tagH}" rx="4" fill="${dirColor}"/>`,
			`<text x="${(tagX + tagW / 2).toFixed(1)}" y="${(tagY + tagH / 2 + 4).toFixed(1)}" font-family="${DEFAULTS.fontFamily}" font-size="11" font-weight="500" fill="#ffffff" text-anchor="middle">${escapeHtml(formatPrice(last.c))}</text>`,
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
				`<text x="${x.toFixed(1)}" y="${(plotBottom + 16).toFixed(1)}" font-family="${DEFAULTS.fontFamily}" font-size="11" fill="${DEFAULTS.axisText}" text-anchor="${anchor}">${escapeHtml(tl.label)}</text>`,
			);
		}
	}

	parts.push("</svg>");
	return parts.join("");
}
