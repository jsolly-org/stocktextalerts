/**
 * Integration test for the Telegram scheduled-market-price dispatch wiring.
 *
 * Scenario: a Telegram-linked user who selected the market_scheduled_asset_price
 * option for the Telegram channel (email/SMS off) runs through the normal
 * `processMarketScheduledUser` path and receives a Telegram price snapshot — a
 * notification_log row with delivery_method='telegram', the telegram
 * scheduled_notifications row marked sent, and stats.telegramSent incremented.
 * Disabling the pref skips Telegram entirely.
 *
 * Uses the real Supabase client + seeded data (createTestUser). The Telegram
 * sender is a test double; the price snapshot is passed directly via `priceMap`
 * so no provider call happens (sparklines are mocked empty).
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../../src/lib/logging";
import { processMarketScheduledUser } from "../../../../src/lib/market-notifications/scheduled/process";
import type { EmailSender } from "../../../../src/lib/messaging/email/utils";
import { attachPrefsToUsers } from "../../../../src/lib/messaging/load-prefs";
import type { SmsSender } from "../../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../../src/lib/user-record-types";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../../setup";

vi.mock("../../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/market-data/sparklines")>(
		"../../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
		fetchIntradaySparklines: vi.fn(async () => new Map()),
	};
});

vi.mock("../../../../src/lib/messaging/logo-fetcher", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/messaging/logo-fetcher")>(
		"../../../../src/lib/messaging/logo-fetcher",
	);
	return {
		...actual,
		safePrefetchLogos: vi.fn(async () => ({ getLogoHtml: () => undefined })),
	};
});

vi.mock("../../../../src/lib/time/market/calendar", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/time/market/calendar")>(
		"../../../../src/lib/time/market/calendar",
	);
	return {
		...actual,
		getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
	};
});

async function seedTelegramScheduledUser(prefEnabled: boolean) {
	// Fixed weekday mid-session instant (Mon 2026-06-15, 11:30 ET / 15:30 UTC). Used as
	// both the due time and currentTime so the run is deterministic — `DateTime.utc()`
	// made the test pass only during ET market hours (the scheduled-delivery guard skips
	// times outside the 4:30 AM–7:30 PM ET window).
	const now = DateTime.fromISO("2026-06-15T15:30:00.000Z", { zone: "utc" });
	const { id } = await createTestUser({
		timezone: "America/New_York",
		emailNotificationsEnabled: false,
		smsNotificationsEnabled: false,
		trackedAssets: ["NVDA"],
		confirmed: true,
	});
	registerTestUserForCleanup(id);

	const telegramChatId = 552201;
	const { error: updateError } = await adminClient
		.from("users")
		.update({
			// 11:00 ET regular-hours slot, due now.
			market_scheduled_asset_price_next_send_at: now.toISO(),
			telegram_chat_id: telegramChatId,
			telegram_opted_out: false,
		})
		.eq("id", id);
	expect(updateError).toBeNull();

	// Per-option prefs live in notification_preferences. createTestUser already seeded
	// market_scheduled email/sms off; enable (or not) the Telegram facet here.
	await setTestUserPrefs(id, [["market_scheduled_asset_price", "", "telegram", prefEnabled]]);

	const { data: userRow, error: selectError } = await adminClient
		.from("users")
		.select("*")
		.eq("id", id)
		.single();
	expect(selectError).toBeNull();
	if (!userRow) throw new Error("expected seeded user row");
	// processMarketScheduledUser reads user.prefs, so attach the freshly-seeded rows.
	const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);
	return { id, telegramChatId, userRow: userWithPrefs as unknown as UserRecord, now };
}

describe("Telegram scheduled market-price dispatch", () => {
	it("A Telegram-linked user with the market_scheduled_asset_price Telegram pref enabled receives a Telegram snapshot.", async () => {
		const { id, telegramChatId, userRow, now } = await seedTelegramScheduledUser(true);

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const telegramSender = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-sched-1",
		}));

		const stats = await processMarketScheduledUser({
			user: userRow,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
			getTelegramSender: () => ({ sender: telegramSender }),
			priceMap: new Map([["NVDA", { price: 178.42, changePercent: 1.37, prevClose: 176.01 }]]),
			marketSession: "regular",
		});

		expect(stats.telegramSent).toBe(1);
		expect(stats.telegramFailed).toBe(0);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(smsSender).not.toHaveBeenCalled();
		expect(telegramSender).toHaveBeenCalledTimes(1);

		const sent = telegramSender.mock.calls[0]?.[0];
		expect(sent?.chatId).toBe(telegramChatId);
		expect(sent?.text).toContain("NVDA");

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("delivery_method, message_delivered, type, message")
			.eq("user_id", id)
			.eq("delivery_method", "telegram");
		expect(logs).toHaveLength(1);
		expect(logs?.[0]?.message_delivered).toBe(true);
		expect(logs?.[0]?.type).toBe("market");
		expect(logs?.[0]?.message).toContain("NVDA");

		const { data: scheduled } = await adminClient
			.from("scheduled_notifications")
			.select("status, channel")
			.eq("user_id", id)
			.eq("notification_type", "market")
			.eq("channel", "telegram")
			.maybeSingle();
		expect(scheduled?.status).toBe("sent");
	});

	it("A Telegram-linked user with the pref disabled receives no Telegram message.", async () => {
		const { id, userRow, now } = await seedTelegramScheduledUser(false);

		const telegramSender = vi.fn<TelegramSender>(async () => ({ success: true }));

		const stats = await processMarketScheduledUser({
			user: userRow,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({ sender: vi.fn<SmsSender>(async () => ({ success: true })) }),
			getTelegramSender: () => ({ sender: telegramSender }),
			priceMap: new Map([["NVDA", { price: 178.42, changePercent: 1.37, prevClose: 176.01 }]]),
			marketSession: "regular",
		});

		expect(telegramSender).not.toHaveBeenCalled();
		expect(stats.telegramSent).toBe(0);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("delivery_method")
			.eq("user_id", id)
			.eq("delivery_method", "telegram");
		expect(logs).toHaveLength(0);
	});

	it("A bot-blocked (403) Telegram send opts the user out for future ticks.", async () => {
		// The failed send is logged as an error by the delivery path — expected here.
		expectConsoleError("Failed to send scheduled market Telegram message");
		const { id, userRow, now } = await seedTelegramScheduledUser(true);

		// The bot was blocked by the user → Telegram returns error_code 403.
		const telegramSender = vi.fn<TelegramSender>(async () => ({
			success: false,
			error: "Forbidden: bot was blocked by the user",
			errorCode: "403",
		}));

		const stats = await processMarketScheduledUser({
			user: userRow,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({ sender: vi.fn<SmsSender>(async () => ({ success: true })) }),
			getTelegramSender: () => ({ sender: telegramSender }),
			priceMap: new Map([["NVDA", { price: 178.42, changePercent: 1.37, prevClose: 176.01 }]]),
			marketSession: "regular",
		});

		expect(telegramSender).toHaveBeenCalledOnce();
		expect(stats.telegramFailed).toBe(1);
		expect(stats.telegramSent).toBe(0);

		// End-to-end: the verified 403 flips telegram_opted_out so future ticks skip this user.
		const { data: user } = await adminClient
			.from("users")
			.select("telegram_opted_out")
			.eq("id", id)
			.single();
		expect(user?.telegram_opted_out).toBe(true);
	});
});
