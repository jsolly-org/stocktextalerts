import { describe, expect, it } from "vitest";
import type { SparklineTimeLabel } from "../../../src/lib/messaging/svg-sparkline";
import { toSvgSparklineImg } from "../../../src/lib/messaging/svg-sparkline";

function decodeSvg(imgTag: string): string {
	const base64 = imgTag.match(/base64,([^"]+)/)?.[1] ?? "";
	return Buffer.from(base64, "base64").toString("utf-8");
}

describe("toSvgSparklineImg", () => {
	it("returns an <img> tag with base64 data URI", () => {
		const result = toSvgSparklineImg([1, 2, 3, 5, 7, 5, 3], "#15803d");
		expect(result).toContain("<img ");
		expect(result).toContain("data:image/svg+xml;base64,");
		expect(result).toContain('alt="sparkline"');
	});

	it("Sparkline img scales down on mobile email so a narrow column doesn't push the row off the right edge", () => {
		// The asset-row table renders inside a ~230-300px-wide container on iOS
		// Mail / Fastmail. The HTML `width`/`height` attributes used to pin the
		// auto-layout cell to the img's natural size, defeating CSS shrinkage
		// entirely on Fastmail (which strips most inline CSS). Dropping those
		// attributes plus a smaller 80px SVG keeps the row inside the body.
		const result = toSvgSparklineImg([1, 2, 3, 5, 7, 5, 3], "#15803d");
		expect(result).not.toMatch(/<img[^>]*\swidth="/);
		expect(result).not.toMatch(/<img[^>]*\sheight="/);
		expect(result).toContain("max-width: 100%");
		expect(result).toContain("height: auto");
	});

	it("returns empty string for fewer than 2 values", () => {
		expect(toSvgSparklineImg([], "#15803d")).toBe("");
		expect(toSvgSparklineImg([42], "#15803d")).toBe("");
	});

	it("uses the provided color in the SVG", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#dc2626");
		const svg = decodeSvg(result);
		expect(svg).toContain("#dc2626");
	});

	it("produces valid SVG with polyline and polygon", () => {
		const result = toSvgSparklineImg([10, 20, 15], "#15803d");
		const svg = decodeSvg(result);
		expect(svg).toContain("<polyline");
		expect(svg).toContain("<polygon");
		expect(svg).toContain("linearGradient");
	});

	it("respects custom width and height", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#15803d", 200, 50);
		const svg = decodeSvg(result);
		expect(svg).toContain('width="200"');
		expect(svg).toContain('height="50"');
	});

	it("handles flat values without error", () => {
		const result = toSvgSparklineImg([5, 5, 5, 5], "#15803d");
		expect(result).toContain("<img ");
		expect(result).toContain("data:image/svg+xml;base64,");
	});

	it("renders time labels with ticks when provided", () => {
		const labels: SparklineTimeLabel[] = [
			{ position: 0, label: "9:30a" },
			{ position: 1, label: "2:15p" },
		];
		const result = toSvgSparklineImg([1, 2, 3, 5, 7], "#15803d", 200, 40, "chart", labels);
		const svg = decodeSvg(result);
		expect(svg).toContain("9:30a");
		expect(svg).toContain("2:15p");
		expect(svg).toContain("<text");
		expect(svg).toContain("<line");
		// Total height should increase by axis height (14)
		expect(svg).toContain('height="54"');
	});

	it("does not add axis when timeLabels is undefined", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#15803d", 120, 30);
		expect(decodeSvg(result)).toContain('height="30"');
	});

	it("does not add axis when timeLabels is empty", () => {
		const result = toSvgSparklineImg([1, 2, 3], "#15803d", 120, 30, "sparkline", []);
		expect(decodeSvg(result)).toContain('height="30"');
	});

	it("renders intermediate hourly labels with correct text-anchor", () => {
		const labels: SparklineTimeLabel[] = [
			{ position: 0, label: "9:30a" },
			{ position: 0.5, label: "12p" },
			{ position: 1, label: "2:30p" },
		];
		const result = toSvgSparklineImg([1, 2, 3, 5, 7], "#15803d", 200, 40, "chart", labels);
		const svg = decodeSvg(result);
		expect(svg).toContain('text-anchor="start"');
		expect(svg).toContain('text-anchor="middle"');
		expect(svg).toContain('text-anchor="end"');
		expect(svg).toContain("12p");
	});
});
