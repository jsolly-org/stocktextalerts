import { describe, expect, it } from "vitest";
import {
	formatAssetHtmlLine,
	formatAssetsHtmlList,
	formatAssetTextLine,
	formatSignedChangePercent,
	formatUsdPrice,
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
		expect(line).toBe("AAPL — $187.42 (+5.56%) past 7 days: ▁▂▃▄▅▆▇");
	});

	it("An intraday-since-prev-close sparkline in SMS is prefixed with `today:` (Robinhood-style)", () => {
		const sparkline: SparklineData = {
			// First value is yesterday's close; the rest are today's bars.
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-prev-close",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		// Change-% is chart-derived (180 → 188 = +4.44%), not the quote's +1.23%.
		expect(line).toBe("AAPL — $187.42 (+4.44%) today: ▁▂▄▆▇▆▇");
	});

	it("A flat-alert intraday-since-open sparkline in SMS is prefixed with `since open:` to disambiguate from the prev-close-anchored default", () => {
		const sparkline: SparklineData = {
			values: [180, 181, 184, 187, 188, 187, 188],
			ascii: "▁▂▄▆▇▆▇",
			window: "intraday-since-open",
		};
		const line = formatAssetTextLine(asset, price, sparkline);
		// Change-% follows the since-open chart (180 → 188 = +4.44%) so the
		// number beside the chart always matches its direction.
		expect(line).toBe("AAPL — $187.42 (+4.44%) since open: ▁▂▄▆▇▆▇");
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

	it("A 7-day sparkline is colored by its own first-to-last move, not today's headline change-%", () => {
		// Market-closed digests show 7-day change-% aligned with the chart.
		const sparkline: SparklineData = {
			values: [75, 76, 77, 78, 79, 79.5],
			ascii: "▁▂▃▄▅▇",
			window: "7-trading-days",
		};
		const downToday = { price: 79.5, changePercent: -1.2 };
		const html = formatAssetHtmlLine(asset, downToday, sparkline, undefined, true);
		expect(html).toContain("(+6.00%)");
		expect(html).toContain("color: #166534");
		const base64 = html.match(/base64,([^"]+)/)?.[1] ?? "";
		const svg = Buffer.from(base64, "base64").toString("utf-8");
		expect(svg).toContain("#166534");
		expect(svg).not.toContain("#b91c1c");
	});

	it("Mobile-viewport email: the asset table fits its container and the sparkline cell can shrink", () => {
		// Email clients render the asset list inside a ~230px-wide container on
		// iOS Mail. The table needs width:100% so it never expands past its
		// wrapper, and the trend cell (label + sparkline) must NOT be nowrap —
		// otherwise the row overflows the right edge.
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
		// Find the trend cell (the one wrapping the svg img). It now also
		// contains the inline `Today:` label span before the img.
		const trendCellMatch = result.match(
			/<td[^>]*>(?:[^<]|<(?!\/td))*<img src="data:image\/svg\+xml;base64/,
		);
		expect(trendCellMatch).not.toBeNull();
		const trendCell = trendCellMatch?.[0] ?? "";
		expect(trendCell).not.toContain("white-space: nowrap");
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
		// Display % follows the since-open chart (180 → 188 = +4.44%) in green,
		// not the quote's +1.23% — the email path must stay in lockstep with the
		// chart for this window too (hit in production when prevClose is missing).
		expect(html).toContain("(+4.44%)");
		expect(html).not.toContain("1.23%");
		expect(html).toContain("color: #166534");
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

describe("Change-% beside an intraday chart derives from the chart itself, never a diverging vendor field", () => {
	// 2026-06-11 LDOS incident: Massive's `todaysChangePerc` (-0.06%, computed
	// from its own lagging trade feed) disagreed in sign with the displayed
	// price vs prev close (122.24 vs 121.69 = +0.45%). The chart — anchored at
	// prev close and ending at the live price — rendered green while the
	// headline % rendered red. The % shown next to a chart must come from the
	// same series endpoints that color the chart.
	const asset = { symbol: "LDOS", name: "Leidos Holdings" };
	const quote = { price: 122.24, changePercent: -0.06, prevClose: 121.69 };
	const sparkline: SparklineData = {
		// [prev close, ...today's 5-min bars, live snapshot price]
		values: [121.69, 121.62, 121.95, 121.55, 121.58, 122.24],
		ascii: "▂▁▅▁▁█",
		window: "intraday-since-prev-close",
	};

	it("Email row shows the prev-close-anchored +0.45% in green, matching the green chart", () => {
		const html = formatAssetHtmlLine(asset, quote, sparkline);
		expect(html).toContain("(+0.45%)");
		expect(html).not.toContain("-0.06%");
		// Headline % cell is green.
		expect(html).toContain("color: #166534");
		expect(html).not.toContain("color: #b91c1c");
		// Chart stroke is the same green.
		const base64 = html.match(/base64,([^"]+)/)?.[1] ?? "";
		const svg = Buffer.from(base64, "base64").toString("utf-8");
		expect(svg).toContain("#166534");
		expect(svg).not.toContain("#b91c1c");
	});

	it("SMS row shows the same chart-derived +0.45% beside the ascii sparkline", () => {
		const line = formatAssetTextLine(asset, quote, sparkline);
		expect(line).toBe("LDOS — $122.24 (+0.45%) today: ▂▁▅▁▁█");
	});

	it("Without a sparkline the row falls back to the quote's change-%", () => {
		const line = formatAssetTextLine(asset, quote, null);
		expect(line).toBe("LDOS — $122.24 (-0.06%)");
	});
});

describe("After-hours change-% rendering", () => {
	it("A subscriber receiving a 6 PM ET SMS sees the day's prev-close-anchored move (Robinhood-style)", () => {
		// Headline change-% during after-hours is anchored to yesterday's close,
		// matching the convention used by Robinhood/Yahoo/Apple Stocks. The
		// sparkline is anchored to the same yesterday's close (prev close
		// prepended to today's bars) so chart shape and change-% always agree
		// on direction.
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

describe("Prices render with thousands separators consistently across channels", () => {
	it("formatUsdPrice groups thousands and keeps 2 decimals", () => {
		expect(formatUsdPrice(1247.83)).toBe("$1,247.83");
		expect(formatUsdPrice(416.5)).toBe("$416.50");
		expect(formatUsdPrice(1234567.8)).toBe("$1,234,567.80");
	});

	it("formatSignedChangePercent always signs and uses 2 decimals (>=0 gets +)", () => {
		expect(formatSignedChangePercent(1.5)).toBe("+1.50%");
		expect(formatSignedChangePercent(-4.2)).toBe("-4.20%");
		expect(formatSignedChangePercent(0)).toBe("+0.00%");
	});

	it("A four-figure asset price in the shared line renders with a comma", () => {
		const line = formatAssetTextLine(
			{ symbol: "BRK.B", name: "Berkshire Hathaway" },
			{ price: 1483.27, changePercent: 0.8 },
		);
		expect(line).toBe("BRK.B — $1,483.27 (+0.80%)");
	});
});
