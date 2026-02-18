import { describe, expect, it } from "vitest";
import { toSvgSparklineImg } from "../../../src/lib/messaging/svg-sparkline";

describe("toSvgSparklineImg", () => {
	it("returns an <img> tag with base64 data URI", () => {
		const result = toSvgSparklineImg([1, 2, 3, 5, 7, 5, 3], "#15803d");
		expect(result).toContain("<img ");
		expect(result).toContain("data:image/svg+xml;base64,");
		expect(result).toContain('alt="Intraday price chart since market open"');
	});

	it("returns empty string for fewer than 2 values", () => {
		expect(toSvgSparklineImg([], "#15803d")).toBe("");
		expect(toSvgSparklineImg([42], "#15803d")).toBe("");
	});

	it("uses the provided color in the SVG", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#dc2626");
		// Decode the base64 to check SVG content
		const base64 = result.match(/base64,([^"]+)/)?.[1] ?? "";
		const svg = Buffer.from(base64, "base64").toString("utf-8");
		expect(svg).toContain("#dc2626");
	});

	it("produces valid SVG with polyline and polygon", () => {
		const result = toSvgSparklineImg([10, 20, 15], "#15803d");
		const base64 = result.match(/base64,([^"]+)/)?.[1] ?? "";
		const svg = Buffer.from(base64, "base64").toString("utf-8");
		expect(svg).toContain("<polyline");
		expect(svg).toContain("<polygon");
		expect(svg).toContain("linearGradient");
	});

	it("respects custom width and height", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#15803d", 200, 50);
		expect(result).toContain('width="200"');
		expect(result).toContain('height="50"');
	});

	it("handles flat values without error", () => {
		const result = toSvgSparklineImg([5, 5, 5, 5], "#15803d");
		expect(result).toContain("<img ");
		expect(result).toContain("data:image/svg+xml;base64,");
	});
});
