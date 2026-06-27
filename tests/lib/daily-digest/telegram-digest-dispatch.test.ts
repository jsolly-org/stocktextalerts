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
import { attachPrefsToUsers } from "../../../src/lib/messaging/load-prefs";
import type { SmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import type { TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

// Mock market calendar to avoid real Massive API calls with test keys.
vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

// Mock market-data so a deterministic quote is returned without a live call.
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

vi.mock("../../../src/lib/market-data/session", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/session")>(
		"../../../src/lib/market-data/session",
	);
	return {
		...actual,
		getCurrentMarketSession: getCurrentMarketSessionMock,
	};
});

vi.mock("../../../src/lib/market-data/prices", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/prices")>(
		"../../../src/lib/market-data/prices",
	);
	return {
		...actual,
		fetchAssetPricesWithSessionState: fetchAssetPricesWithSessionStateMock,
	};
});

vi.mock("../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/sparklines")>(
		"../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
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

vi.mock("../../../src/lib/market-data/movers", () => ({
	fetchTopMovers: vi.fn().mockResolvedValue([]),
}));

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

		// Select the daily-digest "prices" facet for the Telegram channel (createTestUser
		// seeded it off by default; setTestUserPrefs upserts it on).
		await setTestUserPrefs(id, [["daily_digest", "prices", "telegram", true]]);

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
		if (!userRow) throw new Error("expected seeded user row");
		// processDailyDigestUser reads user.prefs, so attach the freshly-seeded rows.
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		const sendEmail = vi.fn<EmailSender>(async () => ({ success: true }));
		const smsSender = vi.fn<SmsSender>(async () => ({ success: true }));
		const telegramSender = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "telegram-msg-1",
		}));

		const stats = await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
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

	it("Precompute stages the Telegram digest content so the deliver phase can send it.", async () => {
		// Regression guard: the precompute/stage path historically persisted only
		// email + sms, silently dropping Telegram from every staged daily digest.
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

		const telegramChatId = 778899124;
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				daily_digest_time: 9 * 60,
				daily_digest_next_send_at: nowIso,
				telegram_chat_id: telegramChatId,
				telegram_opted_out: false,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		await setTestUserPrefs(id, [["daily_digest", "prices", "telegram", true]]);

		fetchAssetPricesWithSessionStateMock.mockResolvedValueOnce({
			prices: new Map([["NVDA", { price: 178.42, changePercent: 1.37, prevClose: 176.01 }]]),
			noSessionTrade: new Set<string>(),
		});

		const { data: userRow } = await adminClient.from("users").select("*").eq("id", id).single();
		if (!userRow) throw new Error("expected seeded user row");
		const [userWithPrefs] = await attachPrefsToUsers(adminClient, [userRow]);

		const telegramSender = vi.fn<TelegramSender>(async () => ({ success: true }));

		// stageOnly = precompute: render + persist content, send nothing.
		await processDailyDigestUser({
			user: userWithPrefs as unknown as UserRecord,
			supabase: adminClient,
			logger: rootLogger,
			currentTime: now,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			getSmsSender: () => ({ sender: vi.fn<SmsSender>(async () => ({ success: true })) }),
			getTelegramSender: () => ({ sender: telegramSender }),
			stageOnly: true,
		});

		// Nothing is sent during precompute.
		expect(telegramSender).not.toHaveBeenCalled();

		// The staged row carries fully-rendered Telegram content (text + entities).
		const { data: stagedRow } = await adminClient
			.from("staged_notifications")
			.select("staged_data")
			.eq("user_id", id)
			.eq("notification_type", "daily")
			.single();
		const staged = stagedRow?.staged_data as {
			telegram: { text: string; entities: unknown[] } | null;
		} | null;
		expect(staged?.telegram).not.toBeNull();
		expect(staged?.telegram?.text).toContain("NVDA");
		expect(Array.isArray(staged?.telegram?.entities)).toBe(true);
	});
});
