import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import type { EmailRequest, TelegramMessage } from "../../../src/lib/messaging/types";
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

import {
	processDailyDigestEmailDelivery,
	processDailyDigestTelegramDelivery,
} from "../../../src/lib/daily-digest/delivery";

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

describe("processDailyDigestTelegramDelivery prediction-market photos", () => {
	const sends: TelegramMessage[] = [];
	const sender = vi.fn(async (message: TelegramMessage): Promise<DeliveryResult> => {
		sends.push(message);
		return { success: true, messageSid: "1" };
	});

	function installSuccessfulSender(): void {
		sender.mockReset().mockImplementation(async (message: TelegramMessage) => {
			sends.push(message);
			return { success: true, messageSid: "1" };
		});
	}

	beforeEach(() => {
		sends.length = 0;
		installSuccessfulSender();
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
			logger: noopLogger,
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
			stats: { ...emptyStats },
		});
	}

	it("sends one silent PNG and omits bars only for cards that rendered", async () => {
		const ok = binaryCard("pm:ok", "NVDA");
		const fail = binaryCard("pm:fail", "AAPL");
		renderChartPng.mockImplementation(async (svg: string) =>
			svg.includes("NVDA binary market") ? pngMagic : null,
		);

		await runDelivery({ assetCards: [ok, fail] });

		expect(sender).toHaveBeenCalledTimes(2);
		expect(sends.length).toBe(2);
		const textMsg = sends[0];
		const photoMsg = sends[1];
		expect(textMsg?.photo).toBeUndefined();
		expect(textMsg?.mediaGroup).toBeUndefined();
		expect(textMsg?.replyMarkup).toBeDefined();
		expect(textMsg?.text).toContain("NVDA binary market");
		expect(textMsg?.text).toContain("AAPL binary market");
		const nvdaIdx = textMsg?.text.indexOf("NVDA binary market") ?? -1;
		const aaplIdx = textMsg?.text.indexOf("AAPL binary market") ?? -1;
		const nvdaBlock = textMsg?.text.slice(nvdaIdx, aaplIdx) ?? "";
		expect(nvdaBlock).not.toContain("█");
		expect(nvdaBlock).toContain("View full market");
		expect(textMsg?.text).toMatch(/AAPL binary market[\s\S]*?█/);
		expect(photoMsg?.photo).toEqual(pngMagic);
		expect(photoMsg?.mediaGroup).toBeUndefined();
		expect(photoMsg?.disableNotification).toBe(true);
		expect(photoMsg?.replyMarkup).toBeUndefined();
	});

	it("regression: many PNGs send exactly one text message + one mediaGroup album", async () => {
		renderChartPng.mockResolvedValue(pngMagic);
		const cards = [
			binaryCard("pm:pltr", "PLTR"),
			binaryCard("pm:spcx", "SPCX"),
			binaryCard("pm:tsla", "TSLA"),
		];

		await runDelivery({ assetCards: cards });

		expect(sender).toHaveBeenCalledTimes(2);
		expect(sends).toHaveLength(2);
		const [textMsg, albumMsg] = sends;
		expect(textMsg?.photo).toBeUndefined();
		expect(textMsg?.mediaGroup).toBeUndefined();
		expect(textMsg?.replyMarkup).toBeDefined();
		expect(albumMsg?.photo).toBeUndefined();
		expect(albumMsg?.replyMarkup).toBeUndefined();
		expect(albumMsg?.disableNotification).toBe(true);
		expect(albumMsg?.mediaGroup).toHaveLength(3);
		expect(albumMsg?.mediaGroup?.[0]?.text).toBeTruthy();
		expect(albumMsg?.mediaGroup?.[1]?.text).toBeUndefined();
		expect(albumMsg?.mediaGroup?.[2]?.text).toBeUndefined();
		expect(sends.filter((m) => m.photo !== undefined)).toHaveLength(0);
	});

	it("regression: asset + macro cards still send one text + one album", async () => {
		renderChartPng.mockResolvedValue(pngMagic);
		await runDelivery({
			assetCards: [binaryCard("pm:pltr", "PLTR"), binaryCard("pm:tsla", "TSLA")],
			macroCards: [binaryCard("pm:spcx", "SPCX")],
		});

		expect(sender).toHaveBeenCalledTimes(2);
		expect(sends[1]?.mediaGroup).toHaveLength(3);
		expect(sends.filter((m) => m.photo !== undefined)).toHaveLength(0);
	});

	it("keeps unicode bars and skips photos when every render fails", async () => {
		renderChartPng.mockResolvedValue(null);
		await runDelivery({ assetCards: [binaryCard("pm:x", "NVDA")] });
		expect(sender).toHaveBeenCalledTimes(1);
		expect(sends.length).toBe(1);
		expect(sends[0]?.photo).toBeUndefined();
		expect(sends[0]?.mediaGroup).toBeUndefined();
		expect(sends[0]?.text).toContain("█");
	});

	it("opts out when the album send returns 403", async () => {
		renderChartPng.mockResolvedValue(pngMagic);
		sender.mockReset().mockImplementation(async (message: TelegramMessage) => {
			sends.push(message);
			if (message.mediaGroup !== undefined) {
				return { success: false, error: "blocked", errorCode: "403" };
			}
			return { success: true, messageSid: "text" };
		});

		await runDelivery({
			assetCards: [binaryCard("pm:nvda", "NVDA"), binaryCard("pm:tsla", "TSLA")],
		});

		expect(sender).toHaveBeenCalledTimes(2);
		expect(sends[1]?.mediaGroup).toHaveLength(2);
		expect(optOutIfBotBlocked).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			expect.objectContaining({ success: false, errorCode: "403" }),
			expect.anything(),
		);
	});

	it("opts out when a single photo send returns 403", async () => {
		renderChartPng.mockResolvedValue(pngMagic);
		sender.mockReset().mockImplementation(async (message: TelegramMessage) => {
			sends.push(message);
			if (message.photo !== undefined) {
				return { success: false, error: "blocked", errorCode: "403" };
			}
			return { success: true, messageSid: "text" };
		});

		await runDelivery({ assetCards: [binaryCard("pm:nvda", "NVDA")] });

		expect(sender).toHaveBeenCalledTimes(2);
		expect(sends[1]?.photo).toEqual(pngMagic);
		expect(optOutIfBotBlocked).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			expect.objectContaining({ success: false, errorCode: "403" }),
			expect.anything(),
		);
	});
});

describe("processDailyDigestEmailDelivery prediction-market regression", () => {
	const emailSends: EmailRequest[] = [];
	const sendEmail = vi.fn(async (request: EmailRequest): Promise<DeliveryResult> => {
		emailSends.push(request);
		return { success: true, messageSid: "email-1" };
	});

	beforeEach(() => {
		emailSends.length = 0;
		sendEmail.mockClear();
		claimScheduledChannel.mockReset().mockResolvedValue(1);
		reserveScheduledChannelBudget.mockReset().mockResolvedValue(true);
		completeScheduledChannelFromResult.mockReset().mockResolvedValue(undefined);
	});

	it("regression: several prediction markets still send exactly one email", async () => {
		const cards = [
			binaryCard("pm:pltr", "PLTR"),
			binaryCard("pm:spcx", "SPCX"),
			binaryCard("pm:tsla", "TSLA"),
		];

		await processDailyDigestEmailDelivery({
			user: makeUserRecord({
				id: "user-1",
				email: "dev@example.com",
				timezone: "America/New_York",
				use_24_hour_time: false,
			}),
			supabase: {} as SupabaseAdminClient,
			logger: noopLogger,
			scheduledDate: "2026-07-27" as IsoDateString,
			scheduledMinutes: 480 as MinuteOfDay,
			userAssets: [{ symbol: "NVDA", name: "NVIDIA", type: "stock" } as UserAssetRow],
			assetPrices: new Map([
				["NVDA", { price: 100, changePercent: 1, asOf: "2026-07-27T16:00:00.000Z" }],
			]) as AssetPriceMap,
			extras: {
				predictionMarketsDigest: {
					assetCards: cards,
					macroCards: [],
				},
			},
			sendEmail,
			stats: { ...emptyStats },
		});

		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(emailSends).toHaveLength(1);
		const body = emailSends[0]?.body ?? "";
		const html = emailSends[0]?.html ?? "";
		expect(body).toContain("PLTR binary market");
		expect(body).toContain("SPCX binary market");
		expect(body).toContain("TSLA binary market");
		expect(html).toContain("PLTR binary market");
		expect(html).toContain("SPCX binary market");
		expect(html).toContain("TSLA binary market");
	});
});
