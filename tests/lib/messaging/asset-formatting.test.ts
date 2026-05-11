import { describe, expect, it } from "vitest";
import {
	formatAssetHtmlLine,
	formatAssetsHtmlList,
	formatAssetTextLine,
	getSafeHrefUrl,
} from "../../../src/lib/messaging/asset-formatting";
import type { SparklineData } from "../../../src/lib/messaging/sparkline";

describe("getSafeHrefUrl prevents XSS via dangerous URL schemes.", () => {
	it("Returns trimmed URL for valid https URLs.", () => {
		expect(getSafeHrefUrl("https://example.com")).toBe("https://example.com");
		expect(getSafeHrefUrl("  https://example.com  ")).toBe("https://example.com");
	});

	it("Returns trimmed URL for valid http URLs.", () => {
		expect(getSafeHrefUrl("http://example.com")).toBe("http://example.com");
	});

	it("Accepts mixed-case schemes.", () => {
		expect(getSafeHrefUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
		expect(getSafeHrefUrl("Http://example.com")).toBe("Http://example.com");
	});

	it("Returns null for javascript: scheme.", () => {
		expect(getSafeHrefUrl("javascript:alert(1)")).toBeNull();
		expect(getSafeHrefUrl("  javascript:alert(1)")).toBeNull();
	});

	it("Returns null for data: scheme.", () => {
		expect(getSafeHrefUrl("data:text/html,<h1>xss</h1>")).toBeNull();
	});

	it("Returns null for vbscript: scheme.", () => {
		expect(getSafeHrefUrl("vbscript:MsgBox('xss')")).toBeNull();
	});

	it("Returns null for empty string.", () => {
		expect(getSafeHrefUrl("")).toBeNull();
	});

	it("Returns null for whitespace-only input.", () => {
		expect(getSafeHrefUrl("   ")).toBeNull();
	});

	it("Returns null for non-string input.", () => {
		expect(getSafeHrefUrl(undefined as unknown as string)).toBeNull();
		expect(getSafeHrefUrl(null as unknown as string)).toBeNull();
		expect(getSafeHrefUrl(123 as unknown as string)).toBeNull();
	});

	it("Returns null for URLs without a scheme.", () => {
		expect(getSafeHrefUrl("example.com")).toBeNull();
		expect(getSafeHrefUrl("//example.com")).toBeNull();
	});

	it("Returns null for non-http(s) schemes.", () => {
		expect(getSafeHrefUrl("ftp://example.com")).toBeNull();
		expect(getSafeHrefUrl("file:///etc/passwd")).toBeNull();
	});
});

describe("A subscriber receives email asset rows with logos when logo data is available.", () => {
	const assets = [
		{ symbol: "AAPL", name: "Apple Inc." },
		{ symbol: "MSFT", name: "Microsoft Corporation" },
	];
	const getPrice = (symbol: string) => {
		if (symbol === "AAPL") return { price: 187.42, changePercent: 1.23 };
		if (symbol === "MSFT") return { price: 412.1, changePercent: -0.31 };
		return undefined;
	};
	it("A subscriber sees the asset logo before the ticker symbol in each email row.", () => {
		const getLogoHtml = (symbol: string) =>
			symbol === "AAPL"
				? '<img src="data:image/png;base64,abc" alt="" width="20" height="20" />'
				: undefined;

		const result = formatAssetsHtmlList(assets, getPrice, {
			getLogoHtml,
		});

		const [aaplLine, msftLine] = result.split("<br>");
		// AAPL should have the logo img before its symbol
		expect(aaplLine).toContain(
			'<img src="data:image/png;base64,abc" alt="" width="20" height="20" />AAPL',
		);
		// MSFT should not have any img tag (getLogoHtml returned undefined for MSFT)
		expect(msftLine).not.toContain("<img");
		expect(msftLine).toContain("<strong>MSFT</strong>");
	});

	it("A subscriber still sees standard asset rows when no logo is available.", () => {
		const result = formatAssetsHtmlList(assets, getPrice);

		expect(result).toContain("<strong>AAPL</strong>");
		expect(result).not.toContain("<img");
	});
});

describe("A subscriber receiving a notification sees a label naming the sparkline's time window", () => {
	const asset = { symbol: "AAPL", name: "Apple Inc." };
	const price = { price: 187.42, changePercent: 1.23 };

	it("A 7-day sparkline in SMS is prefixed with `7d:` so the reader knows the window", () => {
		const sparkline: SparklineData = {
			values: [180, 182, 183, 185, 187, 189, 190],
			ascii: "▁▂▃▄▅▆▇",
			window: "7-trading-days",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		expect(line).toBe("AAPL — $187.42 (+1.23%) 7d: ▁▂▃▄▅▆▇");
	});

	it("An intraday sparkline in SMS is prefixed with `today:` so the reader knows it's this session", () => {
		const sparkline: SparklineData = {
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-open",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		expect(line).toBe("AAPL — $187.42 (+1.23%) today: ▁▂▄▆▇▆▇");
	});

	it("A 7-day sparkline in email HTML carries a `Past 7 trading days:` label next to the SVG", () => {
		const sparkline: SparklineData = {
			values: [180, 182, 183, 185, 187, 189, 190],
			ascii: "▁▂▃▄▅▆▇",
			window: "7-trading-days",
		};
		const html = formatAssetHtmlLine(asset, price, sparkline);
		expect(html).toContain("Past 7 trading days:");
		expect(html).toContain("data:image/svg+xml;base64,");
	});

	it("An intraday sparkline in email HTML carries a `Today since open:` label next to the SVG", () => {
		const sparkline: SparklineData = {
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-open",
		};
		const html = formatAssetHtmlLine(asset, price, sparkline);
		expect(html).toContain("Today since open:");
		expect(html).toContain("data:image/svg+xml;base64,");
	});

	it("No sparkline data → no label appears in SMS", () => {
		const line = formatAssetTextLine(asset, price, null);
		expect(line).toBe("AAPL — $187.42 (+1.23%)");
		expect(line).not.toContain("7d:");
		expect(line).not.toContain("today:");
	});
});

describe("After-hours change-% rendering", () => {
	it("A subscriber receiving a 6 PM ET SMS sees the live after-hours move, not 0.00%", () => {
		// User-visible regression guard for the after-hours staleness bug.
		// Before the parser + dayCloseRegular fix: price=415.20 (locked 4 PM
		// close) and change-% = (415.20 - 415.20) / 415.20 = +0.00%.
		// After: price=416.50 (live after-hours min.c) and change-% =
		// (416.50 - 415.20) / 415.20 ≈ +0.31%.
		const line = formatAssetTextLine(
			{ symbol: "MSFT", name: "Microsoft" },
			{
				price: 416.5,
				changePercent: 1.5, // Massive's todaysChangePerc (vs prevDay) — must be overridden after-hours.
				prevClose: 410.0,
				dayCloseRegular: 415.2,
			},
			null,
			true,
			"after",
		);
		expect(line).toBe("MSFT — $416.50 (+0.31%)");
	});

	it("Falls back to prev-day baseline with the † footnote marker when today's regular close is unavailable", () => {
		// When fetchTodaysRegularCloses can't get today's 4 PM close (e.g.,
		// fired before the daily aggregate is ready or the API errors), the
		// renderer uses the prev-day baseline and signals the fallback via †.
		const line = formatAssetTextLine(
			{ symbol: "MSFT", name: "Microsoft" },
			{
				price: 416.5,
				changePercent: 1.5,
				prevClose: 410.0,
				dayCloseRegular: null,
			},
			null,
			true,
			"after",
		);
		expect(line).toBe("MSFT — $416.50 (+1.50%†)");
	});
});
