import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import {
	deliverPriceTargetAlert,
	formatPriceTargetSms,
	type PriceTargetDeliveryStats,
} from "../../../src/lib/price-targets/delivery";
import type { PriceTargetUser, TriggeredPriceTarget } from "../../../src/lib/price-targets/process";
import type { DeliveryResult } from "../../../src/lib/types";
import { makePrefRows } from "../../helpers/user-record-fixture";

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
		telegramSent: 0,
		telegramFailed: 0,
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
		email_notifications_enabled: true,
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: true,
		sms_opted_out: false,
		telegram_chat_id: null,
		telegram_opted_out: false,
		prefs: makePrefRows([
			["price_targets", "", "email", true],
			["price_targets", "", "sms", true],
		]),
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
			user: makeUser({
				prefs: makePrefRows([
					["price_targets", "", "email", true],
					["price_targets", "", "sms", false],
				]),
			}),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: null,
			stats,
		});

		expect(sendEmail).toHaveBeenCalledOnce();
		expect(stats.emailsSent).toBe(1);
	});

	it("No email is sent when the user disabled email globally, even if the price-target email facet is still on", async () => {
		// Global email kill-switch off + a stale per-option email facet on. The
		// facet alone must not override the global opt-out (it does for the 4 other
		// notification types; price targets used to leak here).
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({
				email_notifications_enabled: false,
				prefs: makePrefRows([
					["price_targets", "", "email", true],
					["price_targets", "", "sms", false],
				]),
			}),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms: null,
			stats,
		});

		expect(sendEmail).not.toHaveBeenCalled();
		expect(stats.emailsSent).toBe(0);
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

	it("SMS is skipped (not counted as a failure) when the user is opted out", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		const outcome = await deliverPriceTargetAlert({
			user: makeUser({ sms_opted_out: true }),
			target: makeTarget(),
			supabase: makeSupabaseMock(),
			sendEmail,
			sendSms,
			stats,
		});

		expect(sendSms).not.toHaveBeenCalled();
		// Ineligibility is a skip, not a delivery failure — it must not inflate smsFailed
		// nor block the target from clearing once email succeeds.
		expect(outcome.sms).toBe("skipped");
		expect(stats.smsFailed).toBe(0);
	});

	it("SMS is skipped (not counted as a failure) when the phone number is missing", async () => {
		const sendSms = vi.fn<(_: { to: string; body: string }) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		const outcome = await deliverPriceTargetAlert({
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
		expect(outcome.sms).toBe("skipped");
		expect(stats.smsFailed).toBe(0);
	});

	it("SMS failure is counted when user has SMS enabled but sender is unavailable", async () => {
		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const stats = makeStats();

		// Suppress expected error log when SMS sender is unavailable
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await deliverPriceTargetAlert({
			user: makeUser({
				prefs: makePrefRows([
					["price_targets", "", "email", true],
					["price_targets", "", "sms", true],
				]),
			}),
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
			user: makeUser({
				prefs: makePrefRows([
					["price_targets", "", "email", true],
					["price_targets", "", "sms", false],
				]),
			}),
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
