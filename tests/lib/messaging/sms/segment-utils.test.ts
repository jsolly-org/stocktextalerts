import { describe, expect, it } from "vitest";
import { SMS_UCS2_SEGMENT_SIZE } from "../../../../src/lib/constants";
import { formatDailyDigestSmsMessages } from "../../../../src/lib/daily-digest/delivery";
import {
	finalizeSmsBodyForUcs2Segments,
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

	it("does not treat zero-length spans as straddling a segment", () => {
		expect(spanStraddlesBoundary(0, 0)).toBe(false);
		expect(spanStraddlesBoundary(SMS_UCS2_SEGMENT_SIZE, SMS_UCS2_SEGMENT_SIZE)).toBe(false);
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

	it("ignores zero-length spans instead of adding padding", () => {
		const msg = "A".repeat(SMS_UCS2_SEGMENT_SIZE);

		expect(
			padSpansToSegmentBoundaries(msg, [
				{ start: SMS_UCS2_SEGMENT_SIZE, end: SMS_UCS2_SEGMENT_SIZE },
			]),
		).toBe(msg);
	});

	it("pads line-start URLs on the URL line so the previous line stays clean", () => {
		// Position second URL so it straddles a UCS-2 segment boundary.
		const prefix = "A".repeat(50);
		const url1 = "https://stocktextalerts.com/r/AAAAA";
		const url2 = "https://stocktextalerts.com/r/BBBBB";
		const msg = `${prefix}${url1}\n${url2}`;

		const result = padUrlsToSegmentBoundaries(msg);
		const url2Index = result.indexOf(url2);

		expect(url2Index).toBeGreaterThan(0);
		expect(result.slice(0, url2Index)).toMatch(/\n +$/);
		expect(result).not.toContain(`${url1} `);
	});

	it("pads line-start http URLs on the URL line too", () => {
		const prefix = "A".repeat(59);
		const url2 = "http://localhost/dashboard";
		const msg = `${prefix}\n${url2}`;

		const result = padUrlsToSegmentBoundaries(msg);
		const url2Index = result.indexOf(url2);

		expect(url2Index).toBeGreaterThan(0);
		expect(result.slice(0, url2Index)).toMatch(/\n +$/);
		expect(result.startsWith(`${prefix}\n`)).toBe(true);
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

describe("finalizeSmsBodyForUcs2Segments", () => {
	it("keeps IPO rows intact when a sample label shifts segment boundaries (4/10 shape)", () => {
		const sparkline = { values: [1, 2, 3], ascii: "▆▆█", window: "7-trading-days" as const };
		const ipos = Array.from({ length: 14 }, (_, index) => {
			const sym = `IPO${String(index + 1).padStart(2, "0")}`;
			return `${sym}: IPO in ${(index % 3) + 1} days (06-0${(index % 9) + 1})`;
		}).join("\n");

		const [body] = formatDailyDigestSmsMessages({
			userAssets: [
				{ symbol: "I01", name: "One" },
				{ symbol: "I02", name: "Two" },
			],
			assetPrices: new Map([
				["I01", { price: 100.12, changePercent: -3.65 }],
				["I02", { price: 101.12, changePercent: -3.65 }],
			]),
			sparklines: new Map([
				["I01", sparkline],
				["I02", sparkline],
			]),
			extras: { news: null, rumors: null, analyst: null, insider: null },
			marketOpen: false,
			marketClosureInfo: { reason: "holiday" },
			assetEvents: {
				eventsSection: { earnings: null, dividends: null, splits: null, ipos },
				analystSection: null,
				insiderSection: null,
				hasAnyContent: true,
			},
		});

		const wrapped = finalizeSmsBodyForUcs2Segments(
			`[STA padding sample]\n4/10 IPO-heavy — few assets, many IPO rows\n\n${body}`,
		);

		for (const line of ipos.split("\n")) {
			const lineIndex = wrapped.indexOf(line);
			expect(lineIndex).toBeGreaterThan(-1);
			expect(spanStraddlesBoundary(lineIndex, lineIndex + line.length)).toBe(false);
		}
		expect(wrapped).not.toMatch(/\n{3,}/);
	});

	it("re-pads daily digest bodies when a prefix shifts the dashboard URL across a segment", () => {
		const prefix = "A".repeat(620);
		const footer = "Manage your notifications: https://stocktextalerts.com/dashboard";
		const digest = `StockTextAlerts — Your daily digest 🗓️\n\n${prefix}\n\n${footer}\n\nReply STOP to opt out.`;
		const wrapped = `[STA padding sample]\n8/10 sample label\n\n${digest}`;

		const url = findUrls(wrapped)[0];
		expect(url).toBeDefined();
		expect(spanStraddlesBoundary(url?.start ?? -1, url?.end ?? -1)).toBe(true);

		const finalized = finalizeSmsBodyForUcs2Segments(wrapped);
		const finalizedUrl = findUrls(finalized)[0];
		expect(finalizedUrl).toBeDefined();
		expect(spanStraddlesBoundary(finalizedUrl?.start ?? -1, finalizedUrl?.end ?? -1)).toBe(false);
		expect(finalized).not.toMatch(/\n{3,}/);
		expect(finalized.indexOf("dashboard")).toBeGreaterThan(-1);
		expect(finalized).not.toContain("dashboar\nd");
	});
});

describe("padDailyDigestSmsSegmentBoundaries", () => {
	it("keeps protected line-start content left-aligned without visible newline padding", () => {
		const prefix = "A".repeat(650);
		const ipoLine = "INIO: IPO in 2 days (06-04)";
		const message = `${prefix}\n${ipoLine}`;

		const padded = padDailyDigestSmsSegmentBoundaries(message);
		const ipoIndex = padded.indexOf(ipoLine);

		expect(ipoIndex).toBeGreaterThan(-1);
		expect(spanStraddlesBoundary(ipoIndex, ipoIndex + ipoLine.length)).toBe(false);
		expect(padded).not.toMatch(/\n{3,}/);
		expect(padded.slice(ipoIndex - 1, ipoIndex)).toBe("\n");
		expect(padded.slice(ipoIndex, ipoIndex + ipoLine.length)).toBe(ipoLine);
	});

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

	it("preserves the blank-line gap before the manage footer after finalize", () => {
		const prefix = "A".repeat(620);
		const digest = `StockTextAlerts — Your daily digest 🗓️\n\n${prefix}\n\n📊 Analyst Consensus\nRTX: 8 Buy, 11 Hold, 0 Sell\n\nManage your notifications:\nhttps://stocktextalerts.com/dashboard\n\nReply STOP to opt out.`;
		const finalized = finalizeSmsBodyForUcs2Segments(digest);

		expect(finalized).toMatch(/\n\nManage your notifications:\nhttps:\/\//);
	});

	it("does not let a segment start on the newline before the manage footer", () => {
		const header = "StockTextAlerts — Your daily digest 🗓️\n";
		const fillerLength =
			(SMS_UCS2_SEGMENT_SIZE - ((header.length + 1) % SMS_UCS2_SEGMENT_SIZE)) %
			SMS_UCS2_SEGMENT_SIZE;
		const digest = `${header}${"A".repeat(fillerLength)}\n\nManage your notifications:\nhttps://stocktextalerts.com/dashboard\n\nReply STOP to opt out.`;
		const finalized = finalizeSmsBodyForUcs2Segments(digest);
		const footerStart = finalized.indexOf("Manage your notifications:");

		expect(footerStart % SMS_UCS2_SEGMENT_SIZE).toBe(0);
		expect(finalized[footerStart]).toBe("M");
		expect(finalized).not.toMatch(/\n\nManage your notifications:/);
	});

	it("protects split footer label and URL as one span", () => {
		const message =
			"Manage your notifications:\nhttps://stocktextalerts.com/dashboard\n\nReply STOP to opt out.";
		const spans = findDailyDigestProtectedSpans(message);
		const texts = spans.map((span) => message.slice(span.start, span.end));

		expect(texts).toContain("Manage your notifications:\nhttps://stocktextalerts.com/dashboard");
		expect(texts.some((text) => text.startsWith("https://"))).toBe(false);
		expect(texts).toContain("Reply STOP to opt out.");
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
