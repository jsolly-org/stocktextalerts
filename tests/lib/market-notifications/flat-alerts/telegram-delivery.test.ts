/**
 * Integration test for the Telegram flat-price-alert (5% move) delivery wiring.
 *
 * Real-time path (mirrors deliverPriceAlert): a Telegram-linked user with the
 * price_move_alerts Telegram pref enabled gets a Telegram message + a
 * notification_log row delivery_method='telegram'; the pref-off / unlinked cases
 * skip Telegram. Per-option prefs are carried on `user.prefs` (the single source
 * of truth); the Supabase mock only records notification_log inserts.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import {
	deliverFlatPriceAlert,
	type FlatPriceAlertDeliveryStats,
} from "../../../../src/lib/market-notifications/flat-alerts/delivery";
import type { FlatPriceAlertUser } from "../../../../src/lib/market-notifications/flat-alerts/users";
import type { EmailSender } from "../../../../src/lib/messaging/email/utils";
import { createLogoCache } from "../../../../src/lib/messaging/logo-fetcher";
import type {
	TelegramMessage,
	TelegramSender,
} from "../../../../src/lib/messaging/telegram/sender";
import type { ExtendedAssetQuote } from "../../../../src/lib/providers/price-fetcher";
import { makePrefRows } from "../../../helpers/user-record-fixture";

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

function makeStats(): FlatPriceAlertDeliveryStats {
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

function makeQuote(overrides: Partial<ExtendedAssetQuote> = {}): ExtendedAssetQuote {
	return {
		price: 173.0,
		prevClose: 194.42,
		changePercent: -11.0,
		dayOpen: 190.0,
		timestamp: 0,
		...overrides,
	} as ExtendedAssetQuote;
}

function makeUser(overrides: Partial<FlatPriceAlertUser> = {}): FlatPriceAlertUser {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		email: "test@example.com",
		email_notifications_enabled: false,
		phone_country_code: "+1",
		phone_number: "5551112222",
		phone_verified: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		use_24_hour_time: false,
		telegram_chat_id: null,
		telegram_opted_out: false,
		prefs: [],
		...overrides,
	};
}

async function deliver(options: { user: FlatPriceAlertUser; sendTelegram: TelegramSender | null }) {
	const { client, inserts } = makeTelegramSupabaseMock();
	const stats = makeStats();
	const delivered = await deliverFlatPriceAlert({
		user: options.user,
		symbol: "LDOS",
		companyName: "Leidos",
		quote: makeQuote(),
		baseline: 194.42,
		triggerPercent: -11.0,
		isReTrigger: false,
		lastNotificationAt: null,
		nowMs: Date.now(),
		todayEt: "2026-06-19",
		intraday: null,
		sevenDaySparkline: null,
		iconUrl: null,
		iconBase64: null,
		supabase: client,
		sendEmail: vi.fn<EmailSender>(async () => ({ success: true })),
		sendSms: null,
		sendTelegram: options.sendTelegram,
		logoCache: createLogoCache(),
		stats,
	});
	return { delivered, inserts, stats };
}

describe("A Telegram-linked user receives a 5% flat-price alert via Telegram", () => {
	it("sends a Telegram message and logs delivery_method='telegram' when the price_move_alerts Telegram pref is enabled", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-flat-1",
		}));

		const { delivered, inserts, stats } = await deliver({
			user: makeUser({
				telegram_chat_id: 778899,
				prefs: makePrefRows([["price_move_alerts", "", "telegram", true]]),
			}),
			sendTelegram,
		});

		expect(delivered).toBe(true);
		expect(sendTelegram).toHaveBeenCalledOnce();
		const sent = sendTelegram.mock.calls[0]![0] as TelegramMessage;
		expect(sent.chatId).toBe(778899);
		expect(sent.text).toContain("LDOS");
		expect(stats.telegramSent).toBe(1);

		const tgLog = inserts.find(
			(i) => i.table === "notification_log" && i.row.delivery_method === "telegram",
		);
		expect(tgLog).toBeDefined();
		expect(tgLog?.row.type).toBe("flat_price_alert");
		expect(tgLog?.row.message_delivered).toBe(true);
	});

	it("skips Telegram when the user has no price_move_alerts Telegram pref enabled", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));

		const { inserts, stats } = await deliver({
			user: makeUser({
				telegram_chat_id: 778899,
				prefs: makePrefRows([["price_move_alerts", "", "telegram", false]]),
			}),
			sendTelegram,
		});

		expect(sendTelegram).not.toHaveBeenCalled();
		expect(stats.telegramSent).toBe(0);
		expect(
			inserts.some((i) => i.table === "notification_log" && i.row.delivery_method === "telegram"),
		).toBe(false);
	});

	it("does not send when the channel is unusable (no linked chat)", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));

		await deliver({
			user: makeUser({
				telegram_chat_id: null,
				prefs: makePrefRows([["price_move_alerts", "", "telegram", true]]),
			}),
			sendTelegram,
		});

		expect(sendTelegram).not.toHaveBeenCalled();
	});
});
