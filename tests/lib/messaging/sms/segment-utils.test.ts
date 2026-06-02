import { describe, expect, it } from "vitest";
import { SMS_UCS2_SEGMENT_SIZE } from "../../../../src/lib/constants";
import {
	findDailyDigestProtectedSpans,
	findLineSpans,
	findUrls,
	padDailyDigestSmsSegmentBoundaries,
	padSpansToSegmentBoundaries,
	padUrlsToSegmentBoundaries,
	spanStraddlesBoundary,
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

describe("spanStraddlesBoundary", () => {
	it("matches urlStraddlesBoundary alias", () => {
		expect(spanStraddlesBoundary(60, 80)).toBe(urlStraddlesBoundary(60, 80));
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

	it("pads line-start URLs at end of previous line, not before the URL", () => {
		// Position second URL so it straddles a UCS-2 segment boundary.
		const prefix = "A".repeat(50);
		const url1 = "https://stocktextalerts.com/r/AAAAA";
		const url2 = "https://stocktextalerts.com/r/BBBBB";
		const msg = `${prefix}${url1}\n${url2}`;

		const result = padUrlsToSegmentBoundaries(msg);
		const url2Index = result.indexOf(url2);

		expect(url2Index).toBeGreaterThan(0);
		expect(result[url2Index - 1]).toBe("\n");
		expect(result).not.toMatch(/\n\s+https:\/\/stocktextalerts\.com\/r\/BBBBB/);
	});
});

describe("findLineSpans", () => {
	it("finds each non-empty line", () => {
		const message = "Header\n\nINIO: IPO in 2 days (06-04)";
		expect(findLineSpans(message)).toEqual([
			{ start: 0, end: 6 },
			{ start: 8, end: 35 },
		]);
	});
});

describe("padSpansToSegmentBoundaries", () => {
	it("pads a protected line that straddles a segment boundary", () => {
		const prefix = "A".repeat(650);
		const line = "INIO: IPO in 2 days (06-04)";
		const message = `${prefix}\n${line}`;

		expect(spanStraddlesBoundary(message.indexOf(line), message.indexOf(line) + line.length)).toBe(
			true,
		);

		const result = padSpansToSegmentBoundaries(
			message,
			findLineSpans(message),
			"newlines-before-span-start",
		);
		const lineIndex = result.indexOf(line);

		expect(lineIndex).toBeGreaterThan(-1);
		expect(spanStraddlesBoundary(lineIndex, lineIndex + line.length)).toBe(false);
		expect(result[lineIndex - 1]).toBe("\n");
	});

	it("skips spans longer than one segment", () => {
		const longLine = "L".repeat(SMS_UCS2_SEGMENT_SIZE + 5);
		const prefix = "A".repeat(60);
		const message = `${prefix}\n${longLine}`;

		expect(padSpansToSegmentBoundaries(message, findLineSpans(message))).toBe(message);
	});

	it("is idempotent after padding", () => {
		const prefix = "A".repeat(650);
		const line = "INIO: IPO in 2 days (06-04)";
		const message = `${prefix}\n${line}`;
		const once = padSpansToSegmentBoundaries(
			message,
			findLineSpans(message),
			"newlines-before-span-start",
		);
		const twice = padSpansToSegmentBoundaries(
			once,
			findLineSpans(once),
			"newlines-before-span-start",
		);

		expect(twice).toBe(once);
	});
});

describe("padDailyDigestSmsSegmentBoundaries", () => {
	it("pads IPO rows and dashboard URLs without double-padding on rerun", () => {
		const prefix = "A".repeat(650);
		const ipoLine = "INIO: IPO in 2 days (06-04)";
		const footer = "Manage your notifications: https://stocktextalerts.com/dashboard";
		const message = `${prefix}\n🆕 Upcoming IPOs\n${ipoLine}\n\n${footer}`;

		const once = padDailyDigestSmsSegmentBoundaries(message);
		const twice = padDailyDigestSmsSegmentBoundaries(once);

		expect(twice).toBe(once);
		const ipoIndex = once.indexOf(ipoLine);
		expect(ipoIndex).toBeGreaterThan(-1);
		expect(spanStraddlesBoundary(ipoIndex, ipoIndex + ipoLine.length)).toBe(false);

		const url = findUrls(once)[0];
		expect(url).toBeDefined();
		expect(spanStraddlesBoundary(url?.start ?? -1, url?.end ?? -1)).toBe(false);
	});

	it("dedupes URL spans nested inside footer line spans", () => {
		const message = "Manage your notifications: https://stocktextalerts.com/dashboard";
		const spans = findDailyDigestProtectedSpans(message);
		const urlOnlySpans = spans.filter((span) =>
			message.slice(span.start, span.end).startsWith("https://"),
		);

		expect(urlOnlySpans).toHaveLength(0);
		expect(spans).toHaveLength(1);
	});

	it("includes a section heading with its first protectable line when they share one newline", () => {
		const message = "🆕 Upcoming IPOs\nINIO: IPO in 2 days (06-04)";
		const spans = findDailyDigestProtectedSpans(message);

		expect(spans).toHaveLength(1);
		expect(message.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe(
			"🆕 Upcoming IPOs\nINIO: IPO in 2 days (06-04)",
		);
	});

	it("falls back to the line span when heading plus line exceeds one segment", () => {
		const heading = "🏦 Insider Trades";
		const line = "LDOS: 8 Buy, 11 Hold, 0 Sell — extra context for boundary test";
		const message = `${heading}\n${line}`;
		const spans = findDailyDigestProtectedSpans(message);

		expect(spans).toHaveLength(1);
		expect(message.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe(line);
		expect((spans[0]?.end ?? 0) - (spans[0]?.start ?? 0)).toBeLessThanOrEqual(
			SMS_UCS2_SEGMENT_SIZE,
		);
	});
});
