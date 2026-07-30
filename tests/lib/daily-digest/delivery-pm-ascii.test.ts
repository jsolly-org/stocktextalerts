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

function binaryCard(
	key: string,
	title: string,
	yesPercent: number,
	symbol?: string,
): PredictionMarketEventCard {
	return {
		key,
		title,
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
				probabilityPercent: yesPercent,
				sortOrder: 0,
				strikeValue: null,
				volume: 1,
			},
			{
				venueContractId: "no",
				label: "No",
				probabilityPercent: Math.round((100 - yesPercent) * 10) / 10,
				sortOrder: 1,
				strikeValue: null,
				volume: 1,
			},
		],
	};
}

const emptyStats = {
	emailsSent: 0,
	emailsFailed: 0,
	telegramSent: 0,
	telegramFailed: 0,
	logFailures: 0,
} as ScheduledNotificationTotals;

const noopLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as Logger;

describe("processDailyDigestTelegramDelivery prediction markets", () => {
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
		optOutIfBotBlocked.mockReset().mockResolvedValue(undefined);
	});

	it("sends one silent text message with Unicode bars in asset and macro sections", async () => {
		const user = makeUserRecord({
			telegram_chat_id: 5550001,
			telegram_opted_out: false,
		});
		const userAssets: UserAssetRow[] = [{ symbol: "PLTR", name: "Palantir" }];
		const assetPrices: AssetPriceMap = new Map([
			[
				"PLTR",
				{
					price: 100,
					changePercent: 1,
					previousClose: 99,
					asOf: "2026-07-26T16:00:00.000Z",
					session: "regular",
				},
			],
		]);

		await processDailyDigestTelegramDelivery({
			user,
			supabase: {} as SupabaseAdminClient,
			logger: noopLogger,
			scheduledDate: "2026-07-26" as IsoDateString,
			scheduledMinutes: 780 as MinuteOfDay,
			userAssets,
			assetPrices,
			extras: {
				predictionMarketsDigest: {
					assetCards: [binaryCard("pltr-close", "Will Palantir close above $120?", 55, "PLTR")],
					macroCards: [binaryCard("us-iran", "US–Iran nuclear deal", 30)],
				},
			},
			dateLabel: "Sat, Jul 26",
			getTelegramSender: () => ({ sender }),
			stats: emptyStats,
		});

		expect(sends).toHaveLength(1);
		expect(sends[0]?.kind).toBe("text");
		if (sends[0]?.kind !== "text") throw new Error("expected text");
		expect(sends[0].disableNotification).toBe(true);
		expect(sends[0].replyMarkup).toBeDefined();
		expect(sends[0].text).toContain("Prediction Markets");
		expect(sends[0].text).toContain("Your Assets");
		expect(sends[0].text).toContain("Macro Weather");

		const assetsIdx = sends[0].text.indexOf("Your Assets");
		const macroIdx = sends[0].text.indexOf("Macro Weather");
		const assetsSection = sends[0].text.slice(assetsIdx, macroIdx);
		const macroSection = sends[0].text.slice(macroIdx);
		expect(assetsSection).toMatch(/Yes\s+55%\s+█/);
		expect(assetsSection).toContain("░");
		expect(macroSection).toMatch(/Yes\s+30%\s+█/);
		expect(macroSection).toContain("░");
		expect(sends[0].text).toContain("Will Palantir close above $120?");
		expect(sends[0].text).toContain("US–Iran nuclear deal");
	});
});
