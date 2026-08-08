import { describe, expect, it } from "vitest";
import {
	buildSubject,
	formatFlatPriceAlertEmail,
} from "../../../../src/lib/market-notifications/flat-alerts/format";
import type { FlatPriceAlertUser } from "../../../../src/lib/market-notifications/flat-alerts/users";
import { EMAIL_LOGO_SIZE_HERO, renderLogoImg } from "../../../../src/lib/messaging/logo-fetcher";
import { hasUnrenderedMarkdownLink } from "../../../../src/lib/messaging/parts/markdown-links";
import type { ExtendedAssetQuote } from "../../../../src/lib/types";

const user: FlatPriceAlertUser = {
	id: "00000000-0000-4000-8000-000000000001",
	email: "dev@example.com",
	delivery_channel: "email" as const,
	use_24_hour_time: false,
	telegram_chat_id: null,

	price_move_why_window_start: null,
	price_move_why_sends_in_window: 0,
	prefs: [],
};

const quote: ExtendedAssetQuote = {
	price: 434.08,
	changePercent: 3.0,
	prevClose: 421.58,
	dayOpen: 420.0,
	dayHigh: 435.0,
	dayLow: 418.0,
	volume: 1_000_000,
	timestamp: Date.parse("2026-07-15T17:00:00Z"),
};

describe("Price move alert email layout", () => {
	it("keeps the asset logo on its own identity row so a long company name cannot shrink it", () => {
		const logoHtml = renderLogoImg("data:image/png;base64,abc123", EMAIL_LOGO_SIZE_HERO);
		const { html } = formatFlatPriceAlertEmail({
			user,
			symbol: "DELL",
			companyName: "Dell Technologies Inc.",
			quote,
			baseline: 421.58,
			isReTrigger: false,
			lastNotificationAt: null,
			nowMs: Date.parse("2026-07-15T17:00:00Z"),
			intraday: null,
			sevenDaySparkline: null,
			logoHtml,
		});

		expect(html).toContain(">Price Move Alert</h2>");
		expect(html).not.toContain("Price Move Alert:");
		expect(html).toContain('width="40" height="40"');
		expect(html).toContain('role="presentation"');
		expect(html).toContain("Dell Technologies Inc.");
		expect(html).toMatch(/\$434\.08/);
	});

	it("buildSubject marks same-direction half-steps as accelerating", () => {
		expect(
			buildSubject({
				symbol: "AAPL",
				currentPrice: 205.2,
				triggerPercent: 2.6,
				isReTrigger: true,
				isAcceleration: true,
			}),
		).toBe("AAPL ↑ 2.6% accelerating since last alert — $205.20");
	});

	it("includes a why blurb after price rows and before the dashboard CTA", () => {
		const why =
			"Update: Shares jumped after the company raised full-year guidance [Reuters](https://www.reuters.com/example).";
		const { text, html } = formatFlatPriceAlertEmail({
			user,
			symbol: "DELL",
			companyName: "Dell Technologies Inc.",
			quote,
			baseline: 421.58,
			isReTrigger: true,
			lastNotificationAt: new Date("2026-07-15T16:00:00Z"),
			nowMs: Date.parse("2026-07-15T17:00:00Z"),
			intraday: null,
			sevenDaySparkline: null,
			logoHtml: undefined,
			whyText: why,
		});

		expect(text).toContain("Update: Shares jumped");
		expect(text).toContain("Reuters (https://www.reuters.com/example)");
		expect(hasUnrenderedMarkdownLink(text)).toBe(false);
		expect(text.indexOf("Update:")).toBeLessThan(text.indexOf("View Dashboard:"));
		expect(html).toContain("Update: Shares jumped");
		expect(html).toContain('href="https://www.reuters.com/example"');
		expect(html).toContain(">Reuters</a>");
		expect(html).not.toContain(">[Reuters]</a>");
		expect(hasUnrenderedMarkdownLink(html)).toBe(false);
		expect(html.indexOf("Update:")).toBeLessThan(html.indexOf("View Dashboard"));
	});

	it("never shows unrendered markdown links in final email copy", () => {
		const why =
			"PLTR shares rose 5.1% in after-hours trading after Q4 results.[[Yahoo Finance]](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)";
		const { text, html } = formatFlatPriceAlertEmail({
			user,
			symbol: "PLTR",
			companyName: "Palantir Technologies Inc.",
			quote,
			baseline: 421.58,
			isReTrigger: false,
			lastNotificationAt: null,
			nowMs: Date.parse("2026-07-15T17:00:00Z"),
			intraday: null,
			sevenDaySparkline: null,
			logoHtml: undefined,
			whyText: why,
		});

		expect(hasUnrenderedMarkdownLink(text)).toBe(false);
		expect(hasUnrenderedMarkdownLink(html)).toBe(false);
		expect(text).toContain(
			"Yahoo Finance (https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)",
		);
		expect(html).toContain(">Yahoo Finance</a>");
		expect(html).not.toContain(">[Yahoo Finance]</a>");
		expect(html).toContain(
			'href="https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html"',
		);
		expect(html).not.toContain("[[Yahoo Finance]]");
	});
});
