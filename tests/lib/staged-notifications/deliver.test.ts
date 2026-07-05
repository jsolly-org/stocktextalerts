/**
 * Vitest tests for the staged notification delivery pipeline (deliver.ts).
 *
 * Covers: empty-result when no rows are due, and staged daily-digest delivery via
 * Telegram (success + failure). Market-type staging was removed when
 * scheduled-market delivery moved fully inline.
 */
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market/calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import type { Logger } from "../../../src/lib/logging";
import { createEmailSender } from "../../../src/lib/messaging/email/utils";
import {
	createTelegramSenderFactory,
	type TelegramSenderFactory,
} from "../../../src/lib/messaging/telegram/sender-factory";
import type { EmailSender, TelegramMessage } from "../../../src/lib/messaging/types";
import { deliverStagedNotifications } from "../../../src/lib/staged-notifications/deliver";
import type { DeliveryResult } from "../../../src/lib/types";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("deliverStagedNotifications", () => {
	const logger: Logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	let sendEmail: EmailSender;
	let getTelegramSender: TelegramSenderFactory;
	// Fake timers are skipped when live email routing is on. nodemailer's
	// SMTP client uses setTimeout internally for connect timeouts and
	// rate limiting, and `vi.useFakeTimers()` freezes setTimeout — the
	// SMTP handshake never fires, and the test deadlocks. Previously this
	// gate was keyed on the (now-removed) live SES path; it's the same
	// fix for a different reason.
	const useFakeTimers = !process.env.EMAIL_SMTP_HOST;

	beforeEach(() => {
		if (useFakeTimers) {
			vi.useFakeTimers();
			vi.setSystemTime(DateTime.fromISO("2026-01-15T15:00:00.000Z").toJSDate());
		}
		vi.clearAllMocks();

		sendEmail = createEmailSender();
		getTelegramSender = createTelegramSenderFactory();
	});

	afterEach(() => {
		if (useFakeTimers) {
			vi.useRealTimers();
		}
		vi.unstubAllEnvs();
	});

	async function clearStagedNotifications() {
		const { data: stagedRows } = await adminClient.from("staged_notifications").select("id");
		if (stagedRows && stagedRows.length > 0) {
			await adminClient
				.from("staged_notifications")
				.delete()
				.in(
					"id",
					stagedRows.map((r) => r.id),
				);
		}
	}

	async function createTelegramDigestUser(options: {
		scheduledForIso: string;
		scheduledMinutes?: number;
	}) {
		const { id } = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: false,
			confirmed: true,
		});
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({
				daily_notification_time: options.scheduledMinutes ?? 9 * 60,
				daily_notification_next_send_at: options.scheduledForIso,
				telegram_chat_id: 778899125,
				telegram_opted_out: false,
			})
			.eq("id", id);
		expect(error).toBeNull();
		return id;
	}

	async function insertStagedDailyTelegram(options: {
		userId: string;
		scheduledForIso: string;
		scheduledDate?: string;
		scheduledMinutes?: number;
		telegram: { text: string; entities: MessageEntity[]; replyMarkup?: InlineKeyboardMarkup };
	}) {
		const { error } = await adminClient.from("staged_notifications").insert({
			user_id: options.userId,
			notification_type: "daily",
			scheduled_for: options.scheduledForIso,
			staged_data: {
				type: "daily",
				scheduledDate: options.scheduledDate ?? "2026-06-01",
				scheduledMinutes: options.scheduledMinutes ?? 9 * 60,
				email: null,
				telegram: options.telegram,
				grokAllowed: false,
				hasAnyAssetEventsOption: false,
				shouldUpdateAnalyst: false,
				analystMonth: null,
			},
		});
		expect(error).toBeNull();
	}

	it("returns empty deliveredUserTypes when no staged rows are due", async () => {
		// Explicitly clear staged rows to avoid depending on cleanup order from prior tests.
		await clearStagedNotifications();

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getTelegramSender,
		});

		expect(result.deliveredUserTypes.size).toBe(0);
		expect(result.stats.emailsSent).toBe(0);
	});

	it("delivers a staged daily digest via Telegram and records the send", async () => {
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createTelegramDigestUser({ scheduledForIso });
		const text = "📊 Daily Digest · Mon, Jun 1\n🟢 AAPL  $192.00  (+1.20%)";
		const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 24 }];
		const replyMarkup: InlineKeyboardMarkup = {
			inline_keyboard: [
				[{ text: "⚙️ Manage notifications", url: "http://localhost/dashboard#daily-notifications" }],
			],
		};
		await insertStagedDailyTelegram({
			userId,
			scheduledForIso,
			telegram: { text, entities, replyMarkup },
		});
		const telegramSender = vi.fn<(message: TelegramMessage) => Promise<DeliveryResult>>(
			async () => ({
				success: true,
			}),
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		expect(telegramSender).toHaveBeenCalledOnce();
		const sent = telegramSender.mock.calls[0]?.[0];
		expect(sent?.chatId).toBe(778899125);
		expect(sent?.text).toBe(text);
		expect(sent?.entities).toEqual(entities);
		// The staged button round-trips through JSON persistence to the outbound message.
		expect(sent?.replyMarkup).toEqual(replyMarkup);
		expect(result.stats.telegramSent).toBe(1);
		expect(result.stats.telegramFailed).toBe(0);

		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("message,message_delivered")
			.eq("user_id", userId)
			.eq("delivery_method", "telegram");
		expect(logRows).toHaveLength(1);
		expect(logRows?.[0]?.message_delivered).toBe(true);
		expect(logRows?.[0]?.message).toBe(text);

		const { data: scheduledRow } = await adminClient
			.from("scheduled_notifications")
			.select("status")
			.eq("user_id", userId)
			.eq("notification_type", "daily")
			.eq("scheduled_date", "2026-06-01")
			.eq("scheduled_minutes", 9 * 60)
			.eq("channel", "telegram")
			.single();
		expect(scheduledRow?.status).toBe("sent");

		// A terminal delivery consumes (deletes) the staged row.
		const { data: stagedRows } = await adminClient
			.from("staged_notifications")
			.select("id")
			.eq("user_id", userId);
		expect(stagedRows).toHaveLength(0);

		// ...and the schedule advanced past the delivered slot (not merely the row deleted).
		const { data: advancedUser } = await adminClient
			.from("users")
			.select("daily_notification_next_send_at")
			.eq("id", userId)
			.single();
		expect(
			DateTime.fromISO(advancedUser?.daily_notification_next_send_at ?? "", {
				zone: "utc",
			}).toMillis(),
		).toBeGreaterThan(DateTime.fromISO(scheduledForIso, { zone: "utc" }).toMillis());
	});

	it("sends a legacy staged Telegram row without replyMarkup buttonless (no throw)", async () => {
		// Rows staged before the button shipped deserialize with replyMarkup: undefined —
		// they must still send, just without the inline keyboard.
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createTelegramDigestUser({ scheduledForIso });
		const text = "📊 Daily Digest · Mon, Jun 1\n🟢 AAPL  $192.00  (+1.20%)";
		const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 24 }];
		// Note: no replyMarkup — the legacy shape.
		await insertStagedDailyTelegram({ userId, scheduledForIso, telegram: { text, entities } });
		const telegramSender = vi.fn<(message: TelegramMessage) => Promise<DeliveryResult>>(
			async () => ({ success: true }),
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		expect(telegramSender).toHaveBeenCalledOnce();
		const sent = telegramSender.mock.calls[0]?.[0];
		expect(sent?.text).toBe(text);
		expect(sent?.replyMarkup).toBeUndefined();
		expect(result.stats.telegramSent).toBe(1);
		expect(result.stats.telegramFailed).toBe(0);
	});

	it("does not advance the schedule when the staged Telegram send fails", async () => {
		await clearStagedNotifications();
		const currentTime = DateTime.fromISO("2026-06-01T13:00:00.000Z", { zone: "utc" });
		const scheduledForIso = currentTime.toISO();
		if (!scheduledForIso) throw new Error("Expected valid scheduled_for timestamp");
		const userId = await createTelegramDigestUser({ scheduledForIso });
		const text = "📊 Daily Digest · Mon, Jun 1\n🔴 TSLA  $201.50  (-2.10%)";
		const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 24 }];
		await insertStagedDailyTelegram({ userId, scheduledForIso, telegram: { text, entities } });
		const telegramSender = vi.fn<(message: TelegramMessage) => Promise<DeliveryResult>>(
			async () => ({
				success: false,
				error: "Telegram 500 Internal Server Error",
				errorCode: "TELEGRAM_500",
			}),
		);

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime,
			sendEmail,
			getTelegramSender: () => ({ sender: telegramSender }),
		});

		expect(telegramSender).toHaveBeenCalledOnce();
		expect(result.stats.telegramSent).toBe(0);
		expect(result.stats.telegramFailed).toBe(1);

		// The Telegram channel row is recorded failed (so monitoring fires + it retries).
		const { data: scheduledRow } = await adminClient
			.from("scheduled_notifications")
			.select("status,error")
			.eq("user_id", userId)
			.eq("notification_type", "daily")
			.eq("channel", "telegram")
			.single();
		expect(scheduledRow?.status).toBe("failed");
		expect(scheduledRow?.error).toContain("Telegram 500");

		// A Telegram-only digest whose send failed must NOT drop the staged row or advance
		// the schedule — otherwise the digest is silently lost with no retry.
		const { data: stagedRows } = await adminClient
			.from("staged_notifications")
			.select("id")
			.eq("user_id", userId);
		expect(stagedRows).toHaveLength(1);

		const { data: notAdvanced } = await adminClient
			.from("users")
			.select("daily_notification_next_send_at")
			.eq("id", userId)
			.single();
		expect(
			DateTime.fromISO(notAdvanced?.daily_notification_next_send_at ?? "", {
				zone: "utc",
			}).toMillis(),
		).toBe(DateTime.fromISO(scheduledForIso, { zone: "utc" }).toMillis());
	});
});
