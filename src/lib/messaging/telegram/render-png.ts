import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { CHART_DEFAULT_WIDTH } from "./candlestick";

/* =============
Rasterization: @resvg/resvg-wasm (pure WASM — no native .node binary, so esbuild
bundles the JS glue and the Lambda build ships the .wasm + font files as plain
assets; see aws/chart-assets.sh). The WASM build loads NO system fonts — and
Lambda has none anyway — so the Roboto TTFs ship alongside and are passed as
fontBuffers on every render.

Node/Lambda ONLY — split from candlestick.ts so the browser (dashboard
notification preview) can import the pure SVG builder without dragging
node:fs/wasm loading into the client bundle; browsers render the SVG natively
and never need this PNG path (PNG exists for Telegram sendPhoto).

Asset resolution is dual-path:
  1. LAMBDA_TASK_ROOT (/var/task): the deploy copies assets to the bundle root.
  2. node_modules subpath resolution: local dev and vitest. (NOT verified on Vercel —
     the dynamic specifiers below aren't statically traceable by @vercel/nft, so a
     future Vercel consumer must ship the assets explicitly.)
If any asset is missing, rendering returns null and callers degrade to a
text-only message — never a crash. The live-provider-check Lambda renders a
probe chart post-deploy, so a missing bundle asset fails the deploy red instead
of silently regressing every notification to text-only (the failure mode that
shipped when the old native @resvg/resvg-js was marked External with no layer).
============= */

/** Rasterize at 2× the SVG's logical width for crisp display on high-DPI screens
 * (Telegram re-compresses every sendPhoto to JPEG, so start sharp). */
const RENDER_SCALE = 2;

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
 * message rather than dropping the notification.
 */
export async function renderChartPng(svg: string): Promise<Buffer | null> {
	if (svg === "") return null;
	chartRuntimePromise ??= loadChartRuntime();
	const runtime = await chartRuntimePromise;
	if (!runtime) return null;
	const widthMatch = svg.match(/width="(\d+)"/);
	const targetWidth = widthMatch?.[1]
		? Number.parseInt(widthMatch[1], 10) * RENDER_SCALE
		: CHART_DEFAULT_WIDTH * RENDER_SCALE;
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
