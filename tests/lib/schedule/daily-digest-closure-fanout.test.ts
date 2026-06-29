import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchDailyDigestUserMock = vi.fn();
const fetchDailyDigestUsersMock = vi.fn();
const fetchUpcomingDailyDigestUsersMock = vi.fn();
const getCurrentMarketSessionMock = vi.fn();
const fetchMarketScheduledUsersMock = vi.fn();
const fetchAssetEventsUsersMock = vi.fn();
const processPriceAlertsMock = vi.fn();
const processPriceTargetsMock = vi.fn();
const getUsMarketClosureInfoForInstantMock = vi.fn();
const fetchAssetPricesWithSessionStateMock = vi.fn();
const batchLoadUserAssetsMock = vi.fn();

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query", () => ({
	fetchDailyDigestUsers: fetchDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
	fetchUpcomingDailyDigestUsers: fetchUpcomingDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/market-notifications/scheduled/query", () => ({
	fetchMarketScheduledUsers: fetchMarketScheduledUsersMock,
}));

vi.mock("../../../src/lib/asset-events/query", () => ({
	fetchAssetEventsUsers: fetchAssetEventsUsersMock,
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

vi.mock("../../../src/lib/time/market/calendar", async () => {
	const actual = await vi.importActual("../../../src/lib/time/market/calendar");
	return {
		...actual,
		getUsMarketClosureInfoForInstant: getUsMarketClosureInfoForInstantMock,
	};
});

vi.mock("../../../src/lib/market-notifications/scheduled/process", () => ({
	processMarketScheduledUser: vi.fn().mockResolvedValue({
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
	}),
}));

vi.mock("../../../src/lib/asset-events/process", () => ({
	processAssetEventsUser: vi.fn(),
}));

vi.mock("../../../src/lib/staged-notifications/deliver", () => ({
	deliverStagedNotifications: vi.fn().mockResolvedValue({
		stats: {
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		},
		deliveredUserTypes: new Set<string>(),
	}),
}));

vi.mock("../../../src/lib/staged-notifications/precompute", () => ({
	precomputeDailyDigest: vi.fn().mockResolvedValue({
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	}),
}));

vi.mock("../../../src/lib/market-notifications/process", () => ({
	processPriceAlerts: processPriceAlertsMock,
}));

vi.mock("../../../src/lib/price-targets/process", () => ({
	processPriceTargets: processPriceTargetsMock,
}));

vi.mock("../../../src/lib/messaging/email/utils", () => ({
	createEmailSender: () => vi.fn(),
}));

vi.mock("../../../src/lib/messaging/sms/sender-factory", () => ({
	createSmsSenderFactory: () => () => ({ sender: "+15555550123" }),
}));

vi.mock("../../../src/lib/market-notifications/snapshot-store", () => ({
	purgeOldAssetSnapshots: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../src/lib/db/user-assets", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/db/user-assets")>(
		"../../../src/lib/db/user-assets",
	);
	return {
		...actual,
		batchLoadUserAssets: batchLoadUserAssetsMock,
	};
});

describe("A cron fallback pass fans out daily digests without a shared closure label.", () => {
	beforeEach(() => {
		dispatchDailyDigestUserMock.mockReset();
		fetchDailyDigestUsersMock.mockReset();
		fetchMarketScheduledUsersMock.mockReset();
		fetchAssetEventsUsersMock.mockReset();
		getCurrentMarketSessionMock.mockReset();
		processPriceAlertsMock.mockReset();
		processPriceTargetsMock.mockReset();
		getUsMarketClosureInfoForInstantMock.mockReset();
		fetchAssetPricesWithSessionStateMock.mockReset();
		batchLoadUserAssetsMock.mockReset();
		fetchUpcomingDailyDigestUsersMock.mockResolvedValue([]);
		batchLoadUserAssetsMock.mockResolvedValue(new Map());
		fetchAssetPricesWithSessionStateMock.mockResolvedValue({
			prices: new Map(),
			noSessionTrade: new Set(),
		});

		processPriceAlertsMock.mockResolvedValue({
			totals: {
				symbolsChecked: 0,
				alertsTriggered: 0,
				cooldownSkips: 0,
				emailsSent: 0,
				emailsFailed: 0,
				smsSent: 0,
				smsFailed: 0,
				logFailures: 0,
			},
			quoteMap: new Map(),
			isMarketOpen: false,
			marketSession: "closed",
		});
		processPriceTargetsMock.mockResolvedValue({
			targetsChecked: 0,
			targetsTriggered: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			logFailures: 0,
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("lets each daily user classify the market day from their own scheduled instant", async () => {
		const { runScheduledNotifications } = await import("../../../src/lib/schedule/run");

		fetchDailyDigestUsersMock.mockResolvedValueOnce([{ id: "daily-user-1" }]);
		fetchMarketScheduledUsersMock.mockResolvedValue([]);
		fetchAssetEventsUsersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		fetchDailyDigestUsersMock.mockResolvedValueOnce([]);
		fetchMarketScheduledUsersMock.mockResolvedValueOnce([]);
		getCurrentMarketSessionMock.mockResolvedValue("closed");
		getUsMarketClosureInfoForInstantMock.mockResolvedValue({
			reason: "weekend",
		});
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
			telegramSent: 0,
			telegramFailed: 0,
		});

		const totals = await runScheduledNotifications({
			supabase: {} as never,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			} as never,
		});

		expect(totals.emailsSent).toBe(1);
		expect(dispatchDailyDigestUserMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "daily-user-1",
				marketOpen: false,
			}),
		);
		expect(dispatchDailyDigestUserMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				marketClosureInfo: expect.anything(),
			}),
		);
		expect(getUsMarketClosureInfoForInstantMock).toHaveBeenCalled();
		expect(getCurrentMarketSessionMock).toHaveBeenCalledTimes(1);
	});

	it("reuses successful market quotes across both scheduler passes without refetching", async () => {
		const { runScheduledNotifications } = await import("../../../src/lib/schedule/run");
		const marketUser = { id: "market-user-1" };

		fetchMarketScheduledUsersMock
			.mockResolvedValueOnce([marketUser])
			.mockResolvedValueOnce([marketUser])
			.mockResolvedValue([]);
		fetchDailyDigestUsersMock.mockResolvedValue([]);
		fetchAssetEventsUsersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		getCurrentMarketSessionMock.mockResolvedValue("regular");
		batchLoadUserAssetsMock.mockResolvedValue(
			new Map([["market-user-1", [{ symbol: "AAPL", name: "Apple", type: "stock" }]]]),
		);
		fetchAssetPricesWithSessionStateMock.mockResolvedValue({
			prices: new Map([["AAPL", { price: 190, changePercent: 1.1, prevClose: 188 }]]),
			noSessionTrade: new Set(),
		});

		await runScheduledNotifications({
			supabase: {} as never,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			} as never,
		});

		expect(fetchAssetPricesWithSessionStateMock).toHaveBeenCalledTimes(1);
		expect(getCurrentMarketSessionMock).toHaveBeenCalledTimes(1);
	});
});
