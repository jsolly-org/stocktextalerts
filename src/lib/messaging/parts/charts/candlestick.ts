import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { IntradayCandle } from "../../../types";
import { escapeHtml } from "../html-utils";

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
	width: 800,
	height: 400,
	upColor: "#1d9e75",
	downColor: "#e24b4a",
	bg: "#ffffff",
	grid: "#eceff3",
	axisText: "#6b7280",
	refLine: "#9ca3af",
	renderScale: 2,
	fontFamily: "Roboto, sans-serif",
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

/* =============
Rasterization: @resvg/resvg-wasm (pure WASM — no native .node binary, so esbuild
bundles the JS glue and the Lambda build ships the .wasm + font files as plain
assets; see aws/deploy-web.sh build_lambdas). The WASM build loads NO system
fonts — and Lambda has none anyway — so the Roboto TTFs ship alongside and are
passed as fontBuffers on every render.

Asset resolution is dual-path:
  1. LAMBDA_TASK_ROOT (/var/task): the deploy copies assets to the bundle root.
  2. node_modules subpath resolution: local dev and vitest. (NOT verified on Vercel —
     the dynamic specifiers below aren't statically traceable by @vercel/nft, so a
     future Vercel consumer, e.g. the dashboard preview, must ship the assets
     explicitly rather than rely on this fallback.)
If any asset is missing, rendering returns null and callers degrade to a
text-only message — never a crash. The live-provider-check Lambda renders a
probe chart post-deploy, so a missing bundle asset fails the deploy red instead
of silently regressing every notification to text-only (the failure mode that
shipped when the old native @resvg/resvg-js was marked External with no layer).
============= */

// INVARIANT: these keys are the bundle-root basenames the deploy copy step ships —
// they must match the asset list in aws/chart-assets.sh, or Lambda reads miss and
// charts silently degrade (caught post-deploy by the chart:render-png live check).
const CHART_ASSET_SPECIFIERS = {
	"index_bg.wasm": "@resvg/resvg-wasm/index_bg.wasm",
	"Roboto_400Regular.ttf": "@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf",
	"Roboto_500Medium.ttf": "@expo-google-fonts/roboto/500Medium/Roboto_500Medium.ttf",
} as const;

const FONT_ASSETS = ["Roboto_400Regular.ttf", "Roboto_500Medium.ttf"] as const;

function readChartAsset(filename: keyof typeof CHART_ASSET_SPECIFIERS): Buffer | null {
	const taskRoot = process.env.LAMBDA_TASK_ROOT;
	if (taskRoot) {
		try {
			return fs.readFileSync(path.join(taskRoot, filename));
		} catch {
			// Fall through to node_modules resolution.
		}
	}
	try {
		// createRequire(import.meta.url) throws in the CJS Lambda bundle (import.meta is
		// empty there) — caught here; on Lambda the task-root read above is the real path.
		return fs.readFileSync(
			createRequire(import.meta.url).resolve(CHART_ASSET_SPECIFIERS[filename]),
		);
	} catch {
		return null;
	}
}

interface ChartRuntime {
	fontBuffers: Uint8Array[];
}

let chartRuntimePromise: Promise<ChartRuntime | null> | undefined;

async function loadChartRuntime(): Promise<ChartRuntime | null> {
	const wasm = readChartAsset("index_bg.wasm");
	if (!wasm) return null;
	const fontBuffers: Uint8Array[] = [];
	for (const asset of FONT_ASSETS) {
		const buffer = readChartAsset(asset);
		// Fail closed on a missing font: a chart with invisible axis text is a bundling
		// bug to surface (via the live check), not a state to render through.
		if (!buffer) return null;
		fontBuffers.push(buffer);
	}
	try {
		await initWasm(wasm);
	} catch (error) {
		// initWasm is once-per-process; vitest re-imports this module per file while the
		// WASM instance persists, so "already initialized" means ready — not failure.
		const message = error instanceof Error ? error.message : String(error);
		if (!/already initialized/i.test(message)) return null;
	}
	return { fontBuffers };
}

/**
 * Rasterize an SVG string to a PNG buffer via resvg-wasm.
 *
 * Returns `null` on failure so the caller can degrade gracefully to a text-only
 * message rather than dropping the notification. Renders at {@link DEFAULTS.renderScale}×
 * the logical width for crisp display on high-DPI screens (Telegram re-compresses
 * every sendPhoto to JPEG, so start sharp).
 */
export async function renderChartPng(svg: string): Promise<Buffer | null> {
	if (svg === "") return null;
	chartRuntimePromise ??= loadChartRuntime();
	const runtime = await chartRuntimePromise;
	if (!runtime) return null;
	const widthMatch = svg.match(/width="(\d+)"/);
	const targetWidth = widthMatch?.[1]
		? Number.parseInt(widthMatch[1], 10) * DEFAULTS.renderScale
		: DEFAULTS.width * DEFAULTS.renderScale;
	try {
		const png = new Resvg(svg, {
			fitTo: { mode: "width", value: targetWidth },
			font: {
				fontBuffers: runtime.fontBuffers,
				defaultFontFamily: "Roboto",
				sansSerifFamily: "Roboto",
			},
		})
			.render()
			.asPng();
		return Buffer.from(png);
	} catch {
		return null;
	}
}
