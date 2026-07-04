import { describe, expect, it } from "vitest";
import { buildCandlestickSvg } from "../../../../src/lib/messaging/telegram/candlestick";
import type { IntradayCandle } from "../../../../src/lib/types";

/** Two bars: first falls (o=101 → c=100), second rises (o=100 → c=102). */
function mixedCandles(): IntradayCandle[] {
	const base = Date.UTC(2026, 5, 19, 14, 35);
	return [
		{ o: 101, h: 101.5, l: 99.5, c: 100, t: base },
		{ o: 100, h: 102.5, l: 99.8, c: 102, t: base + 5 * 60_000 },
	];
}

describe("The candlestick SVG encodes direction redundantly and marks the last close", () => {
	it("draws rising bodies hollow (background fill + colored stroke) and falling bodies solid", () => {
		const svg = buildCandlestickSvg(mixedCandles());
		const rects = svg.match(/<rect [^>]*\/>/g) ?? [];

		// Falling body: solid fill in the down color, no stroke.
		expect(rects.some((r) => r.includes('fill="#e24b4a"') && !r.includes("stroke="))).toBe(true);
		// Rising body: background fill with the up color carried by the stroke, so
		// direction survives grayscale — never encoded by red/green hue alone.
		// (Attribute presence, not order — serialization order is not the contract.)
		expect(rects.some((r) => r.includes('fill="#ffffff"') && r.includes('stroke="#1d9e75"'))).toBe(
			true,
		);
	});

	it("tags the last close with a direction-colored price pill in the right gutter", () => {
		// prevClose above the last close → down day → the tag takes the down color.
		const down = buildCandlestickSvg(mixedCandles(), { prevClose: 104 });
		expect(down).toContain('rx="4" fill="#e24b4a"');
		expect(down).toContain(">102.00</text>");

		// prevClose below → up day → up color.
		const up = buildCandlestickSvg(mixedCandles(), { prevClose: 99 });
		expect(up).toContain('rx="4" fill="#1d9e75"');
	});

	it("returns empty SVG for fewer than 2 candles", () => {
		expect(buildCandlestickSvg([])).toBe("");
		expect(buildCandlestickSvg(mixedCandles().slice(0, 1))).toBe("");
	});
});
