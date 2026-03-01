import { describe, expect, it } from "vitest";
import {
	findUrls,
	padUrlsToSegmentBoundaries,
	urlStraddlesBoundary,
} from "../../../../src/lib/messaging/sms/segment-utils";

describe("findUrls", () => {
	it("finds a single URL", () => {
		const spans = findUrls("Visit https://example.com for info");
		expect(spans).toEqual([{ start: 6, end: 25 }]);
	});

	it("finds multiple URLs", () => {
		const spans = findUrls("See https://a.com and https://b.com/path here");
		expect(spans).toHaveLength(2);
		expect(spans[0]).toEqual({ start: 4, end: 17 });
		expect(spans[1]).toEqual({ start: 22, end: 40 });
	});

	it("returns empty array when no URLs", () => {
		expect(findUrls("no urls here")).toEqual([]);
	});

	it("finds http URLs", () => {
		const spans = findUrls("Visit http://example.com now");
		expect(spans).toHaveLength(1);
	});
});

describe("urlStraddlesBoundary", () => {
	// UCS-2 segment size = 67

	it("returns false when URL fits within one segment", () => {
		// URL from position 0 to 20 — fits in segment 0
		expect(urlStraddlesBoundary(0, 20)).toBe(false);
	});

	it("returns true when URL crosses a segment boundary", () => {
		// URL from position 60 to 80 — crosses from segment 0 to segment 1
		expect(urlStraddlesBoundary(60, 80)).toBe(true);
	});

	it("returns false when URL starts and ends exactly at segment boundary", () => {
		// URL from 67 to 100 — both in segment 1
		expect(urlStraddlesBoundary(67, 100)).toBe(false);
	});

	it("returns false when URL ends exactly at boundary", () => {
		// URL from 50 to 67 — end-1=66, both in segment 0
		expect(urlStraddlesBoundary(50, 67)).toBe(false);
	});
});

describe("padUrlsToSegmentBoundaries", () => {
	it("returns message unchanged when no URLs", () => {
		const msg = "Hello world, no links here";
		expect(padUrlsToSegmentBoundaries(msg)).toBe(msg);
	});

	it("returns message unchanged when URL fits in segment", () => {
		// URL starts at position 0 and is short
		const msg = "https://a.co";
		expect(padUrlsToSegmentBoundaries(msg)).toBe(msg);
	});

	it("pads URL that straddles a boundary", () => {
		// Create a message where a URL starts near position 60 and crosses 67
		const prefix = "A".repeat(60);
		const url = "https://example.com"; // 19 chars, ends at 79
		const msg = `${prefix}${url}`;

		const result = padUrlsToSegmentBoundaries(msg);

		// URL should be pushed to segment boundary at 67
		expect(result).toContain(url);
		// The URL should now start at position 67
		const urlIndex = result.indexOf(url);
		expect(urlIndex).toBe(67);
	});

	it("skips URLs longer than one segment", () => {
		const prefix = "A".repeat(60);
		const longUrl = `https://example.com/${"x".repeat(60)}`; // > 67 chars
		const msg = `${prefix}${longUrl}`;

		const result = padUrlsToSegmentBoundaries(msg);
		// Should not be modified since URL is too long to fix
		expect(result).toBe(msg);
	});
});
