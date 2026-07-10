import { describe, expect, it } from "vitest";
import {
	boldTickerPrefixesHtml,
	boldTickerPrefixesTelegram,
	isTickerPrefixLine,
	matchTickerPrefix,
} from "../../../../src/lib/messaging/parts/ticker-prefix";

describe("matchTickerPrefix", () => {
	it("matches colon-terminated tickers including space suffixes", () => {
		expect(matchTickerPrefix("AAPL: earnings today")).toEqual({
			ticker: "AAPL",
			separator: ":",
			rest: " earnings today",
		});
		expect(matchTickerPrefix("SKHY V: IPO tomorrow — SK Hynix Inc")).toEqual({
			ticker: "SKHY V",
			separator: ":",
			rest: " IPO tomorrow — SK Hynix Inc",
		});
		expect(matchTickerPrefix("BRK.B: news")).toEqual({
			ticker: "BRK.B",
			separator: ":",
			rest: " news",
		});
	});

	it("matches em-dash top-mover lines", () => {
		expect(matchTickerPrefix("JLHL — $12.79 (+586.27%)")).toEqual({
			ticker: "JLHL",
			separator: " — ",
			rest: "$12.79 (+586.27%)",
		});
	});

	it("rejects non-ticker lines", () => {
		expect(matchTickerPrefix("Upcoming IPOs")).toBeNull();
		expect(matchTickerPrefix("  AAPL: indented")).toBeNull();
		expect(matchTickerPrefix("aapl: lowercase")).toBeNull();
		// Section labels use mixed case — not tickers.
		expect(matchTickerPrefix("Gainers:")).toBeNull();
		expect(matchTickerPrefix("Losers:")).toBeNull();
	});
});

describe("isTickerPrefixLine", () => {
	it("detects ticker lines and ignores mixed-case labels", () => {
		expect(isTickerPrefixLine("AAPL: rumor")).toBe(true);
		expect(isTickerPrefixLine("JLHL — $12.79")).toBe(true);
		expect(isTickerPrefixLine("Gainers:")).toBe(false);
		expect(isTickerPrefixLine("plain prose")).toBe(false);
	});
});

describe("boldTickerPrefixesHtml", () => {
	it("bolds colon tickers including space suffixes", () => {
		const html = boldTickerPrefixesHtml(
			"MRCOU: IPO today — Mercator\nSKHY V: IPO tomorrow — SK Hynix Inc",
		);
		expect(html).toContain("<strong>MRCOU:</strong> IPO today — Mercator");
		expect(html).toContain("<strong>SKHY V:</strong> IPO tomorrow — SK Hynix Inc");
	});

	it("bolds top-mover tickers before the em dash", () => {
		const html = boldTickerPrefixesHtml("Gainers:\nJLHL — $12.79 (+586.27%)");
		expect(html).toContain("Gainers:\n<strong>JLHL</strong> — $12.79 (+586.27%)");
		expect(html).not.toContain("<strong>Gainers:</strong>");
	});
});

describe("boldTickerPrefixesTelegram", () => {
	it("emits bold entities for colon and em-dash tickers", () => {
		const msg = boldTickerPrefixesTelegram(
			"SKHY V: IPO tomorrow — SK Hynix Inc\nJLHL — $12.79 (+586.27%)",
		);
		expect(msg.text).toContain("SKHY V: IPO tomorrow — SK Hynix Inc");
		expect(msg.text).toContain("JLHL — $12.79 (+586.27%)");
		const boldSpans = msg.entities.filter((e) => e.type === "bold");
		expect(boldSpans).toHaveLength(2);
		expect(msg.text.slice(boldSpans[0]!.offset, boldSpans[0]!.offset + boldSpans[0]!.length)).toBe(
			"SKHY V:",
		);
		expect(msg.text.slice(boldSpans[1]!.offset, boldSpans[1]!.offset + boldSpans[1]!.length)).toBe(
			"JLHL",
		);
	});
});
