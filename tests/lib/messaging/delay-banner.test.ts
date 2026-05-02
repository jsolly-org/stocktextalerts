import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
	buildDelayBannerHtml,
	buildDelayBannerText,
	DELAY_THRESHOLD_MINUTES,
	getDelayMinutes,
	prependDelayBannerToEmail,
	prependDelayBannerToSms,
} from "../../../src/lib/messaging/delay-banner";

const BASE_TIME = DateTime.fromISO("2026-03-26T14:00:00Z", { zone: "utc" });

describe("getDelayMinutes", () => {
	it("returns 0 when now equals scheduled time", () => {
		expect(getDelayMinutes(BASE_TIME, BASE_TIME)).toBe(0);
	});

	it("returns positive minutes when now is after scheduled time", () => {
		const now = BASE_TIME.plus({ minutes: 10 });
		expect(getDelayMinutes(BASE_TIME, now)).toBe(10);
	});

	it("returns 0 when now is before scheduled time", () => {
		const now = BASE_TIME.minus({ minutes: 5 });
		expect(getDelayMinutes(BASE_TIME, now)).toBe(0);
	});

	it("floors fractional minutes", () => {
		const now = BASE_TIME.plus({ minutes: 7, seconds: 45 });
		expect(getDelayMinutes(BASE_TIME, now)).toBe(7);
	});
});

describe("buildDelayBannerText", () => {
	const opts = (delayMinutes: number) => ({
		scheduledFor: BASE_TIME,
		now: BASE_TIME.plus({ minutes: delayMinutes }),
		userTimezone: "America/New_York",
		use24Hour: false,
	});

	it("returns null when delay is below threshold", () => {
		expect(buildDelayBannerText(opts(0))).toBeNull();
		expect(buildDelayBannerText(opts(DELAY_THRESHOLD_MINUTES - 1))).toBeNull();
	});

	it("returns banner text when delay meets threshold", () => {
		const result = buildDelayBannerText(opts(DELAY_THRESHOLD_MINUTES));
		expect(result).toContain("Delayed");
		expect(result).toContain("originally scheduled for");
	});

	it("respects 24-hour time format", () => {
		const result = buildDelayBannerText({
			...opts(10),
			use24Hour: true,
		});
		expect(result).not.toBeNull();
		// 14:00 UTC = 10:00 ET, in 24h format should not have AM/PM
		expect(result).not.toMatch(/AM|PM/i);
		// Should include timezone abbreviation
		expect(result).toMatch(/E[DS]T/);
	});

	it("uses 12-hour format by default", () => {
		const result = buildDelayBannerText(opts(10));
		expect(result).not.toBeNull();
		expect(result).toMatch(/AM|PM/i);
		// Should include timezone abbreviation
		expect(result).toMatch(/E[DS]T/);
	});
});

describe("buildDelayBannerHtml", () => {
	const opts = (delayMinutes: number) => ({
		scheduledFor: BASE_TIME,
		now: BASE_TIME.plus({ minutes: delayMinutes }),
		userTimezone: "America/New_York",
		use24Hour: false,
	});

	it("returns empty string when delay is below threshold", () => {
		expect(buildDelayBannerHtml(opts(0))).toBe("");
		expect(buildDelayBannerHtml(opts(DELAY_THRESHOLD_MINUTES - 1))).toBe("");
	});

	it("returns HTML banner when delay meets threshold", () => {
		const result = buildDelayBannerHtml(opts(DELAY_THRESHOLD_MINUTES));
		expect(result).toContain("Delayed Notification");
		expect(result).toContain("originally scheduled for");
		expect(result).toContain("<div");
	});
});

describe("prependDelayBannerToSms", () => {
	it("inserts banner after the header line", () => {
		const message = "StockTextAlerts — Your daily digest\n\nAPPL: $150.00\n\nReply STOP";
		const result = prependDelayBannerToSms(message, "⏰ Delayed banner");
		const lines = result.split("\n\n");
		expect(lines[0]).toBe("StockTextAlerts — Your daily digest");
		expect(lines[1]).toBe("⏰ Delayed banner");
		expect(lines[2]).toBe("APPL: $150.00");
	});

	it("handles message without double newline", () => {
		const message = "Single line message";
		const result = prependDelayBannerToSms(message, "⏰ Delayed");
		expect(result).toBe("⏰ Delayed\n\nSingle line message");
	});
});

describe("prependDelayBannerToEmail", () => {
	const sampleHtml = `<!DOCTYPE html><html><body>
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0;">
		<h1>Header</h1>
	</div>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2>Content</h2>
	</div>
</body></html>`;

	it("injects HTML banner after content div opening", () => {
		const { html } = prependDelayBannerToEmail(
			"Header\nContent",
			sampleHtml,
			"⏰ Text banner",
			'<div class="banner">HTML banner</div>',
		);
		const contentDivIdx = html.indexOf("border-radius: 0 0 8px 8px;");
		const bannerIdx = html.indexOf("HTML banner");
		expect(bannerIdx).toBeGreaterThan(contentDivIdx);
		expect(bannerIdx).toBeLessThan(html.indexOf("<h2>Content</h2>"));
	});

	it("prepends text banner after first line", () => {
		const { text } = prependDelayBannerToEmail(
			"Header\nContent body",
			sampleHtml,
			"⏰ Text banner",
			"<div>HTML</div>",
		);
		expect(text).toBe("Header\n⏰ Text banner\nContent body");
	});
});
