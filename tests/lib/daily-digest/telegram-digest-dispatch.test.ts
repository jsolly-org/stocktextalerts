/**
 * Integration test for the Telegram daily-digest dispatch wiring.
 *
 * Scenario: a Telegram-linked user who has selected the daily-digest "prices"
 * facet for the Telegram channel (and disabled email/SMS) runs through the
 * normal dispatch path and receives a Telegram daily digest — a
 * notification_log row with delivery_method='telegram' and
 * message_delivered=true, with stats.telegramSent incremented.
 *
 * Uses the real Supabase client + seeded data (createTestUser). The Telegram
 * sender is a test double; provider calls (Massive prices, market calendar)
 * are stubbed exactly like the email/SMS daily-digest process tests since
 * provider keys never exist in the local suite.
 */
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { processDailyDigestUser } from "../../../src/lib/daily-digest/process";
import { rootLogger } from "../../../src/lib/logging";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

// Mock price-fetcher so a deterministic quote is returned without a live call.
const {
	fetchAssetPricesWithSessionStateMock,
	getCurrentMarketSessionMock,
	fetchIntradaySparklinesMock,
	fetchSparklinesMock,
} = vi.hoisted(() => ({
	fetchAssetPricesWithSessionStateMock: vi.fn(),
	getCurrentMarketSessionMock: vi.fn(),
	fetchIntradaySparklinesMock: vi.fn(),
	fetchSparklinesMock: vi.fn(),
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/price-fetcher")>(
		"../../../src/lib/providers/price-fetcher",
	);
	return {
		...actual,
		fetchAssetPricesWithSessionState: fetchAssetPricesWithSessionStateMock,
		getCurrentMarketSession: getCurrentMarketSessionMock,
		fetchIntradaySparklines: fetchIntradaySparklinesMock,
		fetchSparklines: fetchSparklinesMock,
	};
});

fetchAssetPricesWithSessionStateMock.mockResolvedValue({
	prices: new Map(),
	noSessionTrade: new Set<string>(),
});
getCurrentMarketSessionMock.mockResolvedValue("regular");
fetchIntradaySparklinesMock.mockResolvedValue(new Map());
fetchSparklinesMock.mockResolvedValue(new Map());

// Mock Massive top-movers to avoid the live call (not exercised here, but the
// process module imports it).
vi.mock("../../../src/lib/providers/massive", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/massive")>(
		"../../../src/lib/providers/massive",
	);
	return {
		...actual,
		fetchTopMovers: vi.fn().mockResolvedValue([]),
	};
});

describe("Telegram daily digest dispatch", () => {
	it("A Telegram-linked user with the daily-digest prices facet receives a Telegram digest.", async () => {
		const now = DateTime.utc();
		const nowIso = now.toISO();
		expect(nowIso).toBeTruthy();

		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
			trackedAssets: ["NVDA"],
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		// Link a Telegram chat and schedule the digest to be due now.
		const telegramChatId = 778899123;
		const nineAmLocalMinutes = 9 * 60;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: nineAmLocalMinutes,
				daily_digest_next_send_at: nowIso,
				telegram_chat_id: telegramChatId,
				telegram_opted_out: false,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		// Select the daily-digest "prices" facet for the Telegram channel.
		const { error: prefError } = await adminClient.from("notification_preferences").insert({
			user_id: id,
			notification_type: "daily_digest",
			content: "prices",
			channel: "telegram",
			enabled: true,
		});
		expect(prefError).toBeNull();

		// Realistic NVDA quote during a regular session.
		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["NVDA", { price: 178.42, changePercent: 1.37, prevClose: 176.01 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow, error: selectError } = await adminClient
			.from("users")
			.select("*")
			.eq("id", id)
			.single();
		expect(selectError).toBeNull();
		expect(userRow).not.toBeNull();

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const telegramSender = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "telegram-msg-1",
		}));

		const stats = await processDailyDigestUser({
			user: userRow as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail,
			getSmsSender: () => ({ sender: smsSender }),
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		// Telegram delivered; email/SMS untouched.
		expect(stats.telegramSent).toBe(1);
		expect(stats.telegramFailed).toBe(0);
		expect(stats.emailsSent).toBe(0);
		expect(stats.smsSent).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(smsSender).not.toHaveBeenCalled();
		expect(telegramSender).toHaveBeenCalledTimes(1);

		// The sender received the linked chat id and a non-empty rendered body.
		const sentMessage = telegramSender.mock.calls[0]?.[0];
		expect(sentMessage?.chatId).toBe(telegramChatId);
		expect(sentMessage?.text).toContain("NVDA");

		// notification_log records a delivered Telegram notification.
		const { data: logs, error: logError } = await adminClient
			.from("notification_log")
			.select("delivery_method, message_delivered, message, type")
			.eq("user_id", id)
			.eq("delivery_method", "telegram");
		expect(logError).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs?.[0]?.delivery_method).toBe("telegram");
		expect(logs?.[0]?.message_delivered).toBe(true);
		expect(logs?.[0]?.type).toBe("daily");
		expect(logs?.[0]?.message).toContain("NVDA");

		// The Telegram channel's scheduled_notifications row is marked sent.
		const { data: scheduled } = await adminClient
			.from("scheduled_notifications")
			.select("status, channel")
			.eq("user_id", id)
			.eq("notification_type", "daily")
			.eq("channel", "telegram")
			.maybeSingle();
		expect(scheduled?.status).toBe("sent");
	});
});
