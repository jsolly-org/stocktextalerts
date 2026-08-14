/**
 * Unit tests for the schedule runner's dual user-fetch join.
 *
 * Promise.all rejected on the first fetchUsersWithRetry throw while the sibling
 * was still in Envoy timeout, leaking errors past Lambda END. allSettled waits
 * for both, then throws (preserving the AWS/Lambda Errors contract).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	fetchMarketScheduledUsersMock,
	fetchDailyNotificationUsersMock,
	getCurrentMarketSessionMock,
	getCurrentEquityTradeSessionMock,
} = vi.hoisted(() => ({
	fetchMarketScheduledUsersMock: vi.fn(),
	fetchDailyNotificationUsersMock: vi.fn(),
	getCurrentMarketSessionMock: vi.fn(),
	getCurrentEquityTradeSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/market-notifications/scheduled/query", () => ({
	fetchMarketScheduledUsers: fetchMarketScheduledUsersMock,
}));

vi.mock("../../../src/lib/daily-notification/query", () => ({
	fetchDailyNotificationUsers: fetchDailyNotificationUsersMock,
}));

vi.mock("../../../src/lib/schedule/asset-buyer-digest-wakeup", () => ({
	maybeWakeAssetBuyerFromDailyDigest: vi.fn().mockResolvedValue("skipped"),
}));

vi.mock("../../../src/lib/market-data/session", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/session")>(
		"../../../src/lib/market-data/session",
	);
	return {
		...actual,
		getCurrentMarketSession: getCurrentMarketSessionMock,
		getCurrentEquityTradeSession: getCurrentEquityTradeSessionMock,
	};
});

vi.mock("../../../src/lib/market-data/price-history-cache", () => ({
	getPriceCacheSymbols: vi.fn().mockResolvedValue([]),
	purgeOldPriceHistoryCache: vi.fn().mockResolvedValue({ minutePurged: 0, dailyPurged: 0 }),
	storePriceHistoryMinuteSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/prediction-markets/store", () => ({
	purgeOldPredictionMarketOdds: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../src/lib/market-notifications/flat-alerts/process", () => ({
	processFlatPriceAlerts: vi.fn().mockResolvedValue({
		usersChecked: 0,
		symbolsEvaluated: 0,
		alertsTriggered: 0,
		claimLost: 0,
		firstOfDayAlerts: 0,
		reTriggerAlerts: 0,
		whyEnqueued: 0,
		whyInline: 0,
		lambdaWakeups: 0,
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	}),
}));

vi.mock("../../../src/lib/messaging/senders", () => ({
	createNotificationSenders: () => ({
		sendEmail: vi.fn(),
		getTelegramSender: vi.fn(),
		logoCache: {},
	}),
}));

import { runScheduledNotifications } from "../../../src/lib/schedule/run";
import { resetMarketSessionCache } from "../../helpers/reset-market-session-cache";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("runScheduledNotifications user-fetch join", () => {
	beforeEach(() => {
		resetMarketSessionCache();
		getCurrentMarketSessionMock.mockReset();
		getCurrentMarketSessionMock.mockResolvedValue("closed");
		getCurrentEquityTradeSessionMock.mockReset();
		getCurrentEquityTradeSessionMock.mockResolvedValue("closed");
		fetchMarketScheduledUsersMock.mockReset();
		fetchDailyNotificationUsersMock.mockReset();
	});

	it("throws the market fetch error only after both user fetches have settled", async () => {
		let marketDone = false;
		let dailyDone = false;
		fetchMarketScheduledUsersMock.mockImplementation(async () => {
			await delay(30);
			marketDone = true;
			throw new Error("Failed to fetch scheduled users after 3 attempts");
		});
		fetchDailyNotificationUsersMock.mockImplementation(async () => {
			await delay(80);
			dailyDone = true;
			return [];
		});

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await expect(
			runScheduledNotifications({
				supabase: { rpc: vi.fn(), from: vi.fn() } as never,
				logger: logger as never,
			}),
		).rejects.toThrow("Failed to fetch scheduled users after 3 attempts");

		expect(marketDone).toBe(true);
		expect(dailyDone).toBe(true);
		expect(fetchMarketScheduledUsersMock).toHaveBeenCalledOnce();
		expect(fetchDailyNotificationUsersMock).toHaveBeenCalledOnce();
	});

	it("throws the daily fetch error when only that query rejects", async () => {
		fetchMarketScheduledUsersMock.mockResolvedValue([]);
		fetchDailyNotificationUsersMock.mockRejectedValue(
			new Error("Failed to fetch daily notification users after 3 attempts"),
		);

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await expect(
			runScheduledNotifications({
				supabase: { rpc: vi.fn(), from: vi.fn() } as never,
				logger: logger as never,
			}),
		).rejects.toThrow("Failed to fetch daily notification users after 3 attempts");
	});
});
