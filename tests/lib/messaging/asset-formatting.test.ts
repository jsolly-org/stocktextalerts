import { describe, expect, it } from "vitest";
import {
	formatAssetsHtmlList,
	getSafeHrefUrl,
} from "../../../src/lib/messaging/asset-formatting";

describe("getSafeHrefUrl prevents XSS via dangerous URL schemes.", () => {
	it("Returns trimmed URL for valid https URLs.", () => {
		expect(getSafeHrefUrl("https://example.com")).toBe("https://example.com");
		expect(getSafeHrefUrl("  https://example.com  ")).toBe(
			"https://example.com",
		);
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
