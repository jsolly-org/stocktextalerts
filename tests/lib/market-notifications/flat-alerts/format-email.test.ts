import { describe, expect, it } from "vitest";
import { formatFlatPriceAlertEmail } from "../../../../src/lib/market-notifications/flat-alerts/format";
import type { FlatPriceAlertUser } from "../../../../src/lib/market-notifications/flat-alerts/users";
import { EMAIL_LOGO_SIZE_HERO, renderLogoImg } from "../../../../src/lib/messaging/logo-fetcher";
import type { ExtendedAssetQuote } from "../../../../src/lib/types";

const user: FlatPriceAlertUser = {
	id: "00000000-0000-4000-8000-000000000001",
	email: "dev@example.com",
	email_notifications_enabled: true,
	use_24_hour_time: false,
	telegram_chat_id: null,
	telegram_opted_out: false,
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
});
