import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import type { DeliveryResult } from "../../../src/lib/messaging/types";
import {
	deliverPriceTargetAlert,
	formatPriceTargetSms,
	type PriceTargetDeliveryStats,
} from "../../../src/lib/price-targets/delivery";
import type { PriceTargetUser, TriggeredPriceTarget } from "../../../src/lib/price-targets/process";

function makeSupabaseMock(): AppSupabaseClient {
	return {
		from: () => ({
			insert: async () => ({ error: null }),
		}),
	} as unknown as AppSupabaseClient;
}

function makeStats(): PriceTargetDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		logFailures: 0,
	};
}

function makeTarget(overrides: Partial<TriggeredPriceTarget> = {}): TriggeredPriceTarget {
	return {
		symbol: "AAPL",
		targetPrice: 200,
		currentPrice: 201.35,
		direction: "above",
		...overrides,
	};
}

function makeUser(overrides: Partial<PriceTargetUser> = {}): PriceTargetUser {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		email: "test@example.com",
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: true,
		sms_opted_out: false,
		price_targets_include_email: true,
		price_targets_include_sms: true,
		...overrides,
	};
}

describe("Price target SMS body", () => {
	it("A user sees symbol, target price, and current price in the SMS", () => {
		const body = formatPriceTargetSms(makeTarget());
		expect(body).toContain("AAPL");
		expect(body).toContain("$200.00");
		expect(body).toContain("$201.35");
		expect(body).toContain("Price Target Hit");
	});
});

describe("Price target alert delivery", () => {
	it("A user with email alerts enabled receives the price target email", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({ price_targets_include_sms: false }),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: null,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		expect(stats.emailsSent).toBe(1);
	});

	it("A user with SMS alerts enabled receives the price target SMS", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser(),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).toHaveBeenCalledOnce();
		expect(stats.smsSent).toBe(1);
	});

	it("SMS is not sent and failure is counted when user is opted out", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({ sms_opted_out: true }),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsFailed).toBe(1);
	});

	it("SMS is not sent and failure is counted when phone number is missing", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({
				phone_country_code: null,
				phone_number: null,
			}),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		expect(stats.smsFailed).toBe(1);
	});

	it("SMS failure is counted when user has SMS enabled but sender is unavailable", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		// Suppress expected error log when SMS sender is unavailable
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await deliverPriceTargetAlert({
			user: makeUser({ price_targets_include_sms: true }),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: null,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		expect(stats.smsFailed).toBe(1);

		errorSpy.mockRestore();
	});

	it("A user sees direction and target in the price target email", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({ price_targets_include_sms: false }),
			target: makeTarget({
				direction: "below",
				targetPrice: 150,
				currentPrice: 149.5,
			}),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: null,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		const callArgs = sendEmail.mock.calls[0]![0] as {
			subject: string;
			body: string;
		};
		expect(callArgs.subject).toContain("Price Target Hit");
		expect(callArgs.body).toContain("$150.00");
	});
});
