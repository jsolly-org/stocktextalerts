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

		expect(result).toMatch(
			/<td[^>]*>\s*<img src="data:image\/png;base64,abc"[^>]*\/>\s*<\/td>\s*<td[^>]*>AAPL<\/td>/,
		);
		expect(result).toMatch(/<td[^>]*>\s*<\/td>\s*<td[^>]*>MSFT<\/td>/);
		expect(result).toContain("<table");
	});

	it("A subscriber still sees standard asset rows when no logo is available.", () => {
		const result = formatAssetsHtmlList(assets, getPrice);

		// Empty logo cell sits directly before the AAPL ticker cell — preserves
		// column alignment with rows that *do* have a logo.
		expect(result).toMatch(/<td[^>]*>\s*<\/td>\s*<td[^>]*>AAPL<\/td>/);
		expect(result).not.toContain("<img");
	});
});

describe("A subscriber receiving a notification sees a label naming the sparkline's time window", () => {
	const asset = { symbol: "AAPL", name: "Apple Inc." };
	const price = { price: 187.42, changePercent: 1.23 };

	it("A 7-day sparkline in SMS is prefixed with `past 7 days:` so the reader knows the window", () => {
		const sparkline: SparklineData = {
			values: [180, 182, 183, 185, 187, 189, 190],
			ascii: "▁▂▃▄▅▆▇",
			window: "7-trading-days",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		expect(line).toBe("AAPL — $187.42 (+1.23%) past 7 days: ▁▂▃▄▅▆▇");
	});

	it("An intraday-since-prev-close sparkline in SMS is prefixed with `today:` (Robinhood-style)", () => {
		const sparkline: SparklineData = {
			// First value is yesterday's close; the rest are today's bars.
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-prev-close",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		expect(line).toBe("AAPL — $187.42 (+1.23%) today: ▁▂▄▆▇▆▇");
	});

	it("A flat-alert intraday-since-open sparkline in SMS is prefixed with `since open:` to disambiguate from the prev-close-anchored default", () => {
		const sparkline: SparklineData = {
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-open",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		expect(line).toBe("AAPL — $187.42 (+1.23%) since open: ▁▂▄▆▇▆▇");
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

	it("Mobile-viewport email: the asset table fits its container and the sparkline cell can shrink", () => {
		// Email clients render the asset list inside a ~230px-wide container on
		// iOS Mail. The table needs width:100% so it never expands past its
		// wrapper, and the sparkline cell must NOT pin itself at 120px via
		// white-space:nowrap — otherwise the row overflows the right edge.
		const sparkline: SparklineData = {
			values: [180, 182, 183, 185, 187, 189, 190],
			ascii: "▁▂▃▄▅▆▇",
			window: "intraday-since-prev-close",
		};
		const result = formatAssetsHtmlList([asset], () => price, {
			getSparkline: () => sparkline,
		});
		expect(result).toContain("<table");
		expect(result).toContain("width: 100%");
		// Find the sparkline cell (the one wrapping the svg img) and confirm it
		// is NOT nowrap. We grep for the cell that contains the img.
		const sparklineCellMatch = result.match(/<td[^>]*>\s*<img src="data:image\/svg\+xml;base64/);
		expect(sparklineCellMatch).not.toBeNull();
		const sparklineCell = sparklineCellMatch?.[0] ?? "";
		expect(sparklineCell).not.toContain("white-space: nowrap");
	});

	it("An intraday-since-prev-close sparkline in email HTML carries a `Today:` label next to the SVG", () => {
		const sparkline: SparklineData = {
			// First value is yesterday's close; the rest are today's bars.
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-prev-close",
		};
		const html = formatAssetHtmlLine(asset, price, sparkline);
		expect(html).toContain("Today:");
		expect(html).toContain("data:image/svg+xml;base64,");
	});

	it("A flat-alert intraday-since-open sparkline in email HTML keeps its disambiguating `Today since open:` label", () => {
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
		expect(line).not.toContain("past 7 days:");
		expect(line).not.toContain("since open:");
		expect(line).not.toContain("today:");
	});
});

describe("No-session-trade rendering distinguishes inactive tickers from fetch failures", () => {
	const asset = { symbol: "CACI", name: "CACI International" };

	it("Pre-market SMS row reads `no pre-market trades` when ticker has no live extended-hours bar", () => {
		const line = formatAssetTextLine(asset, "no_session_trade", null, true, "pre");
		expect(line).toBe("CACI — no pre-market trades");
	});

	it("After-hours SMS row reads `no after-hours trades` when ticker has no live extended-hours bar", () => {
		const line = formatAssetTextLine(asset, "no_session_trade", null, true, "after");
		expect(line).toBe("CACI — no after-hours trades");
	});

	it("Pre-market SMS row still reads `price unavailable` when the snapshot fetch missed the ticker entirely", () => {
		const line = formatAssetTextLine(asset, undefined, null, true, "pre");
		expect(line).toBe("CACI — price unavailable");
	});

	it("Pre-market email row reads `no pre-market trades` in muted grey when ticker has no live bar", () => {
		const html = formatAssetHtmlLine(asset, "no_session_trade", null, undefined, true, "pre");
		expect(html).toContain("no pre-market trades");
		expect(html).toContain("color: #6b7280;");
		expect(html).toContain(">CACI</td>");
	});

	it("After-hours email row reads `no after-hours trades` in muted grey when ticker has no live bar", () => {
		const html = formatAssetHtmlLine(asset, "no_session_trade", null, undefined, true, "after");
		expect(html).toContain("no after-hours trades");
		expect(html).toContain("color: #6b7280;");
	});

	it("Regular-session email row falls back to `price unavailable` when ticker is in snapshot but had no trade", () => {
		const html = formatAssetHtmlLine(asset, "no_session_trade", null, undefined, true, undefined);
		expect(html).toContain("price unavailable");
		expect(html).toContain(">CACI</td>");
		expect(html).not.toContain("no pre-market");
		expect(html).not.toContain("no after-hours");
	});
});

describe("After-hours change-% rendering", () => {
	it("A subscriber receiving a 6 PM ET SMS sees the day's prev-close-anchored move (Robinhood-style)", () => {
		// Headline change-% during after-hours is anchored to yesterday's close
		// (Massive's todaysChangePerc), matching the convention used by
		// Robinhood/Yahoo/Apple Stocks. The sparkline is anchored to the same
		// yesterday's close (prev close prepended to today's bars) so chart
		// shape and change-% always agree on direction.
		const line = formatAssetTextLine(
			{ symbol: "MSFT", name: "Microsoft" },
			{
				price: 416.5,
				changePercent: 1.5,
				prevClose: 410.0,
			},
			null,
			true,
			"after",
		);
		expect(line).toBe("MSFT — $416.50 (+1.50%)");
	});
});
