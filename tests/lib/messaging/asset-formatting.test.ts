import { describe, expect, it } from "vitest";
import { getSafeHrefUrl } from "../../../src/lib/messaging/asset-formatting";

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
