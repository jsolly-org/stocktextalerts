/**
 * Integration test for the Telegram price-target delivery wiring.
 *
 * Real-time path (mirrors deliverPriceAlert): a Telegram-linked user with the
 * price_targets Telegram pref enabled gets a Telegram message + a
 * notification_log row delivery_method='telegram'; the pref-off / unlinked cases
 * skip Telegram. Text-only (price targets carry no intraday candles). Per-option
 * prefs are carried on `user.prefs` (the single source of truth); the Supabase
 * mock only records notification_log inserts.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import type { TelegramMessage, TelegramSender } from "../../../src/lib/messaging/telegram/sender";
import {
	deliverPriceTargetAlert,
	type PriceTargetDeliveryStats,
} from "../../../src/lib/price-targets/delivery";
import type { PriceTargetUser, TriggeredPriceTarget } from "../../../src/lib/price-targets/process";
import { makePrefRows } from "../../helpers/user-record-fixture";

type RecordedInsert = { table: string; row: Record<string, unknown> };

function makeTelegramSupabaseMock(): {
	client: AppSupabaseClient;
	inserts: RecordedInsert[];
} {
	const inserts: RecordedInsert[] = [];
	const client = {
		from(table: string) {
			return {
				insert: async (row: Record<string, unknown>) => {
					inserts.push({ table, row });
					return { error: null };
				},
			};
		},
	} as unknown as AppSupabaseClient;
	return { client, inserts };
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
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		telegram_chat_id: null,
		telegram_opted_out: false,
		prefs: [],
		...overrides,
	};
}

describe("A Telegram-linked user receives a price-target alert via Telegram", () => {
	it("sends a Telegram message and logs delivery_method='telegram' when the price_targets Telegram pref is enabled", async () => {
		const { client, inserts } = makeTelegramSupabaseMock();
		const sendTelegram = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-target-1",
		}));
		const stats = makeStats();

		const delivered = await deliverPriceTargetAlert({
			user: makeUser({
				telegram_chat_id: 445566,
				prefs: makePrefRows([["price_targets", "", "telegram", true]]),
			}),
			target: makeTarget(),
			supabase: client,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			sendSms: null,
			sendTelegram,
			stats,
		});

		expect(delivered).toBe(true);
		expect(sendTelegram).toHaveBeenCalledOnce();
		const sent = sendTelegram.mock.calls[0]![0] as TelegramMessage;
		expect(sent.chatId).toBe(445566);
		expect(sent.text).toContain("AAPL");
		// Text-only: no candlestick photo.
		expect(sent.photo).toBeUndefined();
		expect(stats.telegramSent).toBe(1);

		const tgLog = inserts.find(
			(i) => i.table === "notification_log" && i.row.delivery_method === "telegram",
		);
		expect(tgLog).toBeDefined();
		expect(tgLog?.row.type).toBe("price_target");
		expect(tgLog?.row.message_delivered).toBe(true);
	});

	it("skips Telegram when the user has no price_targets Telegram pref enabled", async () => {
		const { client, inserts } = makeTelegramSupabaseMock();
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));
		const stats = makeStats();

		await deliverPriceTargetAlert({
			user: makeUser({
				telegram_chat_id: 445566,
				prefs: makePrefRows([["price_targets", "", "telegram", false]]),
			}),
			target: makeTarget(),
			supabase: client,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			sendSms: null,
			sendTelegram,
			stats,
		});

		expect(sendTelegram).not.toHaveBeenCalled();
		expect(stats.telegramSent).toBe(0);
		expect(
			inserts.some((i) => i.table === "notification_log" && i.row.delivery_method === "telegram"),
		).toBe(false);
	});

	it("does not send when the channel is unusable (no linked chat)", async () => {
		const { client } = makeTelegramSupabaseMock();
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));

		await deliverPriceTargetAlert({
			user: makeUser({
				telegram_chat_id: null,
				prefs: makePrefRows([["price_targets", "", "telegram", true]]),
			}),
			target: makeTarget(),
			supabase: client,
			sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
			sendSms: null,
			sendTelegram,
			stats: makeStats(),
		});

		expect(sendTelegram).not.toHaveBeenCalled();
	});
});
