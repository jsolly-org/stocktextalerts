import { describe, expect, it } from "vitest";
import { buildCandlestickSvg } from "../../../../src/lib/messaging/telegram/candlestick";
import { renderChartPng } from "../../../../src/lib/messaging/telegram/render-png";
import type { IntradayCandle } from "../../../../src/lib/types";

/** Two bars: first falls (o=101 → c=100), second rises (o=100 → c=102). */
function mixedCandles(): IntradayCandle[] {
	const base = Date.UTC(2026, 5, 19, 14, 35);
	return [
		{ o: 101, h: 101.5, l: 99.5, c: 100, t: base },
		{ o: 100, h: 102.5, l: 99.8, c: 102, t: base + 5 * 60_000 },
	];
}

describe("The WASM rasterizer turns the SVG into a real PNG with bundled fonts", () => {
	it("produces a PNG buffer (magic bytes) from a chart SVG", async () => {
		const svg = buildCandlestickSvg(mixedCandles(), {
			prevClose: 100.5,
			timeLabels: [
				{ position: 0, label: "9:30 AM" },
				{ position: 1, label: "4:00 PM" },
			],
		});
		const png = await renderChartPng(svg);
		expect(png).toBeInstanceOf(Buffer);
		expect((png as Buffer).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("returns null for empty SVG instead of throwing", async () => {
		expect(await renderChartPng("")).toBeNull();
	});

	it("degrades to null (never throws) when the rasterizer rejects invalid SVG", async () => {
		// Exercises the try/catch around Resvg.render() through the real rasterizer —
		// the load-bearing contract that a render failure becomes a text-only alert,
		// never a dropped one (deliverTelegramPriceAlert relies on this never throwing).
		expect(await renderChartPng("<not-valid-svg")).toBeNull();
	});
});
