import { describe, expect, it } from "vitest";
import {
	formatPriceAlertTelegram,
	type TelegramPriceAlert,
} from "../../../../src/lib/messaging/telegram/price-alert";
import type { EnrichedAlert } from "../../../../src/lib/price-alerts/types";
import type { IntradayCandle } from "../../../../src/lib/types";

function makeAlert(overrides: Partial<EnrichedAlert> = {}): EnrichedAlert {
	return {
		symbol: "LDOS",
		priceContext: "LDOS is down 11.1% today ($173.00)",
		signalContext: "The broader market (SPY) moved up 0.85% today.",
		grokContext: "down 11.10% from previous close, anomaly score 52/75",
		grokResult: null,
		intradayCloses: null,
		intradayTimestamps: null,
		intradayEndTimestamp: null,
		intradayCandles: null,
		prevClose: 194.42,
		isPositiveMove: false,
		...overrides,
	};
}

/** Build a rising intraday candle series of `count` 5-minute bars. */
function makeCandles(count: number, start = 170): IntradayCandle[] {
	const base = Date.UTC(2026, 5, 19, 14, 35);
	return Array.from({ length: count }, (_, i) => {
		const o = start + i;
		return { o, h: o + 1.2, l: o - 0.8, c: o + 0.6, t: base + i * 5 * 60_000 };
	});
}

describe("A price-move alert is rendered for Telegram with entity formatting and a candlestick chart", () => {
	it("bolds the ticker, carries the price/change line, and produces a PNG when there are ≥2 candles", async () => {
		const result: TelegramPriceAlert = await formatPriceAlertTelegram(makeAlert(), makeCandles(6));

		expect(result.text).toContain("LDOS");
		expect(result.text).toContain("down 11.1% today ($173.00)");
		expect(result.text).toContain("The broader market (SPY) moved up 0.85% today.");

		// Formatting travels out-of-band as entities (no MarkdownV2/HTML escaping).
		expect(result.entities.length).toBeGreaterThan(0);
		expect(result.entities.some((e) => e.type === "bold")).toBe(true);

		// A real PNG buffer is rasterized from the candlestick SVG.
		expect(result.photo).toBeInstanceOf(Buffer);
		expect((result.photo as Buffer).length).toBeGreaterThan(0);
		// PNG magic number: 0x89 'P' 'N' 'G'.
		expect((result.photo as Buffer).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("includes a 'Why it's moving' blockquote from Grok with inline-link markup stripped", async () => {
		const result = await formatPriceAlertTelegram(
			makeAlert({
				grokResult: {
					summary:
						"Leidos fell after cutting guidance amid reduced federal spending.[[Reuters]](https://www.reuters.com/example)",
					links: [
						{
							url: "https://www.reuters.com/example",
							title: "Leidos cuts guidance",
							source: "Reuters",
							sourceType: "web",
						},
					],
				},
			}),
			makeCandles(4),
		);

		expect(result.text).toContain("Why it's moving");
		expect(result.text).toContain("Leidos fell after cutting guidance");
		// The raw "[[Reuters]](url)" markup is collapsed to the plain label, no brackets/url.
		expect(result.text).toContain("Reuters");
		expect(result.text).not.toContain("[[Reuters]]");
		expect(result.text).not.toContain("https://www.reuters.com/example");
		expect(result.entities.some((e) => e.type === "blockquote")).toBe(true);
	});

	it("degrades to a text-only message (no photo, no throw) when there are too few candles", async () => {
		const empty = await formatPriceAlertTelegram(makeAlert(), []);
		expect(empty.photo).toBeNull();
		expect(empty.text).toContain("LDOS");

		const single = await formatPriceAlertTelegram(makeAlert(), makeCandles(1));
		expect(single.photo).toBeNull();
		expect(single.text).toContain("LDOS");
	});
});
