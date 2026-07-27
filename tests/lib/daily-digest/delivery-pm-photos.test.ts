import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import type { TelegramMessage } from "../../../src/lib/messaging/types";
import type { PredictionMarketEventCard } from "../../../src/lib/prediction-markets/types";
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
const renderChartPng = vi.fn();
const optOutIfBotBlocked = vi.fn();

vi.mock("../../../src/lib/messaging/scheduled-channel", () => ({
	claimScheduledChannel: (...args: unknown[]) => claimScheduledChannel(...args),
	reserveScheduledChannelBudget: (...args: unknown[]) => reserveScheduledChannelBudget(...args),
	resolveScheduledSender: (...args: unknown[]) => resolveScheduledSender(...args),
	completeScheduledChannelFromResult: (...args: unknown[]) =>
		completeScheduledChannelFromResult(...args),
}));

vi.mock("../../../src/lib/messaging/telegram/render-png", () => ({
	renderChartPng: (...args: unknown[]) => renderChartPng(...args),
}));

vi.mock("../../../src/lib/messaging/telegram/opt-out", () => ({
	optOutIfBotBlocked: (...args: unknown[]) => optOutIfBotBlocked(...args),
}));

import { processDailyDigestTelegramDelivery } from "../../../src/lib/daily-digest/delivery";

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function binaryCard(key: string, symbol: string): PredictionMarketEventCard {
	return {
		key,
		title: `${symbol} binary market`,
		venue: "polymarket",
		url: `https://polymarket.com/event/${key}`,
		shape: "binary",
		shapeValidated: true,
		closesAt: null,
		refreshedAt: "2026-07-26T00:01:00.000Z",
		volume: 1,
		symbol,
		outcomes: [
			{
				venueContractId: "yes",
				label: "Yes",
				probabilityPercent: 55,
				sortOrder: 0,
				strikeValue: null,
				volume: 1,
			},
			{
				venueContractId: "no",
				label: "No",
				probabilityPercent: 45,
				sortOrder: 1,
				strikeValue: null,
				volume: 1,
			},
		],
	};
}

describe("processDailyDigestTelegramDelivery prediction-market photos", () => {
	const sends: TelegramMessage[] = [];
	const sender = vi.fn(async (message: TelegramMessage): Promise<DeliveryResult> => {
		sends.push(message);
		return { success: true, messageSid: "1" };
	});

	beforeEach(() => {
		sends.length = 0;
		sender.mockClear();
		claimScheduledChannel.mockReset().mockResolvedValue(1);
		reserveScheduledChannelBudget.mockReset().mockResolvedValue(true);
		resolveScheduledSender.mockReset().mockResolvedValue({ sender });
		completeScheduledChannelFromResult.mockReset().mockResolvedValue(undefined);
		renderChartPng.mockReset();
		optOutIfBotBlocked.mockReset().mockResolvedValue(undefined);
	});

	async function runDelivery(options: {
		assetCards: PredictionMarketEventCard[];
		macroCards?: PredictionMarketEventCard[];
	}) {
		await processDailyDigestTelegramDelivery({
			user: makeUserRecord({
				id: "user-1",
				telegram_chat_id: 12345,
				telegram_opted_out: false,
				timezone: "America/New_York",
				use_24_hour_time: false,
			}),
			supabase: {} as SupabaseAdminClient,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			} as unknown as Logger,
			scheduledDate: "2026-07-27" as IsoDateString,
			scheduledMinutes: 480 as MinuteOfDay,
			userAssets: [{ symbol: "NVDA", name: "NVIDIA", type: "stock" } as UserAssetRow],
			assetPrices: new Map([
				["NVDA", { price: 100, changePercent: 1, asOf: "2026-07-27T16:00:00.000Z" }],
			]) as AssetPriceMap,
			extras: {
				predictionMarketsDigest: {
					assetCards: options.assetCards,
					macroCards: options.macroCards ?? [],
				},
			},
			dateLabel: "Sun, Jul 27",
			getTelegramSender: () => ({ sender }),
			stats: {
				emailsSent: 0,
				emailsFailed: 0,
				telegramSent: 0,
				telegramFailed: 0,
				logFailures: 0,
			} as ScheduledNotificationTotals,
		});
	}

	it("sends silent PNGs and omits bars only for cards that rendered", async () => {
		const ok = binaryCard("pm:ok", "NVDA");
		const fail = binaryCard("pm:fail", "AAPL");
		renderChartPng.mockImplementation(async (svg: string) =>
			svg.includes("NVDA binary market") ? pngMagic : null,
		);

		await runDelivery({ assetCards: [ok, fail] });

		expect(sends.length).toBe(2);
		const textMsg = sends[0];
		const photoMsg = sends[1];
		expect(textMsg?.photo).toBeUndefined();
		expect(textMsg?.text).toContain("NVDA binary market");
		expect(textMsg?.text).toContain("AAPL binary market");
		const nvdaIdx = textMsg?.text.indexOf("NVDA binary market") ?? -1;
		const aaplIdx = textMsg?.text.indexOf("AAPL binary market") ?? -1;
		const nvdaBlock = textMsg?.text.slice(nvdaIdx, aaplIdx) ?? "";
		expect(nvdaBlock).not.toContain("█");
		expect(nvdaBlock).toContain("View full market");
		expect(textMsg?.text).toMatch(/AAPL binary market[\s\S]*?█/);
		expect(photoMsg?.photo).toEqual(pngMagic);
		expect(photoMsg?.disableNotification).toBe(true);
		expect(photoMsg?.replyMarkup).toBeUndefined();
	});

	it("keeps unicode bars and skips photos when every render fails", async () => {
		renderChartPng.mockResolvedValue(null);
		await runDelivery({ assetCards: [binaryCard("pm:x", "NVDA")] });
		expect(sends.length).toBe(1);
		expect(sends[0]?.photo).toBeUndefined();
		expect(sends[0]?.text).toContain("█");
	});

	it("stops photo sends and opts out on a mid-batch 403", async () => {
		renderChartPng.mockResolvedValue(pngMagic);
		sender
			.mockResolvedValueOnce({ success: true, messageSid: "text" })
			.mockResolvedValueOnce({ success: false, error: "blocked", errorCode: "403" })
			.mockResolvedValueOnce({ success: true, messageSid: "should-not-send" });

		await runDelivery({
			assetCards: [binaryCard("pm:a", "AAA"), binaryCard("pm:b", "BBB")],
		});

		expect(sender).toHaveBeenCalledTimes(2);
		expect(optOutIfBotBlocked).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			expect.objectContaining({ success: false, errorCode: "403" }),
			expect.anything(),
		);
	});
});
