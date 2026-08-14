import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import type { TelegramMessage } from "../../../src/lib/messaging/types";
import type { ScheduledNotificationTotals } from "../../../src/lib/scheduled-notifications/types";
import type {
	AssetPriceMap,
	DeliveryResult,
	IsoDateString,
	MinuteOfDay,
	UserAssetRow,
} from "../../../src/lib/types";
import { makeUserRecord } from "../../helpers/user-record-fixture";

const claimScheduledChannel = vi.fn();
const reserveScheduledChannelBudget = vi.fn();
const resolveScheduledSender = vi.fn();
const completeScheduledChannelFromResult = vi.fn();
const optOutIfBotBlocked = vi.fn();

vi.mock("../../../src/lib/messaging/scheduled-channel", () => ({
	claimScheduledChannel: (...args: unknown[]) => claimScheduledChannel(...args),
	reserveScheduledChannelBudget: (...args: unknown[]) => reserveScheduledChannelBudget(...args),
	resolveScheduledSender: (...args: unknown[]) => resolveScheduledSender(...args),
	completeScheduledChannelFromResult: (...args: unknown[]) =>
		completeScheduledChannelFromResult(...args),
}));

vi.mock("../../../src/lib/messaging/telegram/opt-out", () => ({
	optOutIfBotBlocked: (...args: unknown[]) => optOutIfBotBlocked(...args),
}));

import { processDailyDigestTelegramDelivery } from "../../../src/lib/daily-digest/delivery";
import { formatDailyDigestTelegram } from "../../../src/lib/messaging/notifications/daily-digest";
import { TELEGRAM_TEXT_MAX_UTF16 } from "../../../src/lib/messaging/telegram/limits";

function emptyStats(): ScheduledNotificationTotals {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
		skipped: 0,
	};
}

const loggerError = vi.fn();
const noopLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: loggerError,
	debug: vi.fn(),
} as unknown as Logger;

function oversizedNewsRumors(): { news: string; rumors: string } {
	const news = Array.from({ length: 12 }, (_, i) => `AAPL: ${"n".repeat(220)} headline ${i}`).join(
		"\n\n",
	);
	const rumors = Array.from({ length: 12 }, (_, i) => `TSLA: ${"r".repeat(220)} chatter ${i}`).join(
		"\n\n",
	);
	return { news, rumors };
}

describe("processDailyDigestTelegramDelivery chunked send", () => {
	const sends: TelegramMessage[] = [];
	const sender = vi.fn(async (message: TelegramMessage): Promise<DeliveryResult> => {
		sends.push(message);
		return { success: true, messageSid: String(sends.length) };
	});

	beforeEach(() => {
		sends.length = 0;
		sender.mockReset();
		sender.mockImplementation(async (message: TelegramMessage): Promise<DeliveryResult> => {
			sends.push(message);
			return { success: true, messageSid: String(sends.length) };
		});
		loggerError.mockClear();
		claimScheduledChannel.mockReset().mockResolvedValue(1);
		reserveScheduledChannelBudget.mockReset().mockResolvedValue(true);
		resolveScheduledSender.mockReset().mockResolvedValue({ sender });
		completeScheduledChannelFromResult
			.mockReset()
			.mockImplementation(
				async (options: { result: DeliveryResult; stats: ScheduledNotificationTotals }) => {
					if (options.result.success) options.stats.telegramSent++;
					else options.stats.telegramFailed++;
				},
			);
		optOutIfBotBlocked.mockReset().mockResolvedValue(undefined);
	});

	async function deliver(extras: { news: string; rumors: string }, stats = emptyStats()) {
		const user = makeUserRecord({
			delivery_channel: "telegram",
			telegram_chat_id: 5550001,
		});
		const userAssets: UserAssetRow[] = [{ symbol: "AAPL", name: "Apple" }];
		const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 100, changePercent: 1 }]]);
		await processDailyDigestTelegramDelivery({
			user,
			supabase: {} as SupabaseAdminClient,
			logger: noopLogger,
			scheduledDate: "2026-08-14" as IsoDateString,
			scheduledMinutes: 540 as MinuteOfDay,
			userAssets,
			assetPrices,
			extras,
			dateLabel: "Fri, Aug 14",
			getTelegramSender: () => ({ sender }),
			stats,
		});
		return stats;
	}

	it("sends each packed chunk and puts the dashboard button on the last message only", async () => {
		const extras = oversizedNewsRumors();
		const packed = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple" }],
			assetPrices: new Map([["AAPL", { price: 100, changePercent: 1 }]]),
			extras,
			dateLabel: "Fri, Aug 14",
		});
		const stats = await deliver(extras);
		expect(sends.length).toBeGreaterThanOrEqual(2);
		expect(sender).toHaveBeenCalledTimes(sends.length);
		expect(stats.telegramSent).toBe(1);
		expect(stats.telegramFailed).toBe(0);
		expect(sends.map((message) => (message.kind === "text" ? message.text : ""))).toEqual(
			packed.map((chunk) => chunk.text),
		);
		const joined = packed.map((chunk) => chunk.text).join("\n\n");
		for (const [index, message] of sends.entries()) {
			expect(message.kind).toBe("text");
			expect(message.disableNotification).toBe(true);
			expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX_UTF16);
			expect(message.text).not.toBe(joined);
			const isLast = index === sends.length - 1;
			if (isLast) {
				expect(message.replyMarkup).toBeDefined();
			} else {
				expect(message.replyMarkup).toBeUndefined();
			}
		}
	});

	it("fails the slot closed when a later chunk send fails", async () => {
		sender.mockImplementation(async (message: TelegramMessage): Promise<DeliveryResult> => {
			sends.push(message);
			if (sends.length === 2) {
				return {
					success: false,
					error: "Bad Request: message is too long",
					errorCode: "400",
				};
			}
			return { success: true, messageSid: String(sends.length) };
		});

		const stats = await deliver(oversizedNewsRumors());
		expect(sends.length).toBe(2);
		expect(stats.telegramSent).toBe(0);
		expect(stats.telegramFailed).toBe(1);
		const completeArg = completeScheduledChannelFromResult.mock.calls[0]?.[0];
		expect(completeArg?.result.success).toBe(false);
		expect(loggerError).toHaveBeenCalledWith(
			"Failed to send Daily Digest Telegram message",
			expect.objectContaining({
				errorCode: "400",
				chunkIndex: 1,
				chunkCount: expect.any(Number),
				textLength: expect.any(Number),
			}),
			expect.any(Error),
		);
	});
});
