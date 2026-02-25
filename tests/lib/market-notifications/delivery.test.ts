import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import {
	deliverPriceAlert,
	type PriceAlertDeliveryStats,
} from "../../../src/lib/market-notifications/delivery";
import type { EnrichedAlert } from "../../../src/lib/market-notifications/enrichment";
import type { PriceAlertUser } from "../../../src/lib/market-notifications/users";
import type { DeliveryResult } from "../../../src/lib/messaging/types";

function makeSupabaseMock(): AppSupabaseClient {
	return {
		from: () => ({
			insert: async () => ({ error: null }),
		}),
	} as unknown as AppSupabaseClient;
}

function makeStats(): PriceAlertDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		logFailures: 0,
	};
}

function makeAlert(overrides: Partial<EnrichedAlert> = {}): EnrichedAlert {
	return {
		symbol: "LDOS",
		priceContext: "LDOS is down 11.1% today ($173.00)",
		signalContext: "down 11.1% (sudden, vol 1.2x)",
		headlines: [],
		aiSummary: null,
		intradayCloses: null,
		...overrides,
	};
}

function makeUser(overrides: Partial<PriceAlertUser> = {}): PriceAlertUser {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		email: "test@example.com",
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: true,
		sms_opted_out: false,
		market_asset_price_alerts_include_email: false,
		market_asset_price_alerts_include_sms: true,
		market_asset_price_alert_risk_priority: "both_equally",
		market_asset_price_alert_market_context: "standout",
		market_asset_price_alert_move_size: "large",
		market_asset_price_alert_follow_up_mode: "first_only",
		use_24_hour_time: false,
		...overrides,
	};
}

describe("deliverPriceAlert SMS eligibility", () => {
	it("does not attempt SMS when user is opted out", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ sms_opted_out: true }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when phone number is missing", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ phone_number: null }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when phone is not verified", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ phone_verified: false }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});

	it("does not attempt SMS when sms_notifications_enabled is false", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({ sms_notifications_enabled: false }),
			alert: makeAlert(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsSent).toBe(0);
		expect(stats.smsFailed).toBe(1);
	});
});

describe("deliverPriceAlert intraday sparklines", () => {
	const intradayCloses = [100, 102, 105, 103, 108, 110, 107];

	it("SMS body contains Unicode sparkline when intradayCloses has data", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ intradayCloses }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0][0].body;
		expect(smsBody).toContain("Today:");
		// Unicode block characters are in the range U+2581–U+2588
		expect(smsBody).toMatch(/[▁▂▃▄▅▆▇█]/);
	});

	it("SMS body has no sparkline when intradayCloses is null", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser(),
			alert: makeAlert({ intradayCloses: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		const smsBody = sendSms.mock.calls[0][0].body;
		expect(smsBody).not.toContain("Today:");
	});

	it("email HTML contains sparkline img when intradayCloses has data", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ intradayCloses }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		// sendEmail receives { to, subject, body, html }
		const emailCall = sendEmail.mock.calls[0][0] as { html: string };
		expect(emailCall.html).toContain("<img");
		expect(emailCall.html).toContain("Today since open:");
	});

	it("email HTML has no sparkline when intradayCloses is null", async () => {
		const sendSms = vi.fn<
			(_: { to: string; body: string }) => Promise<DeliveryResult>
		>(async () => ({ success: true }));
		const sendEmail = vi.fn(async () => ({ success: true }) as const);
		const stats = makeStats();

		await deliverPriceAlert({
			user: makeUser({
				market_asset_price_alerts_include_email: true,
				market_asset_price_alerts_include_sms: false,
			}),
			alert: makeAlert({ intradayCloses: null }),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const emailCall = sendEmail.mock.calls[0][0] as { html: string };
		expect(emailCall.html).not.toContain("Today since open:");
	});
});
