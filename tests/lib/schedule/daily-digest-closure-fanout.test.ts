import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchDailyDigestUserMock = vi.fn();
const fetchDailyDigestUsersMock = vi.fn();
const fetchMarketStatusMock = vi.fn();
const fetchMarketScheduledUsersMock = vi.fn();
const fetchAssetEventsUsersMock = vi.fn();
const processPriceAlertsMock = vi.fn();
const processPriceTargetsMock = vi.fn();
const getUsMarketClosureInfoForInstantMock = vi.fn();

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query", () => ({
	fetchDailyDigestUsers: fetchDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/market-notifications/scheduled/query", () => ({
	fetchMarketScheduledUsers: fetchMarketScheduledUsersMock,
}));

vi.mock("../../../src/lib/asset-events/query", () => ({
	fetchAssetEventsUsers: fetchAssetEventsUsersMock,
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual(
		"../../../src/lib/providers/price-fetcher",
	);
	return {
		...actual,
		fetchAssetPrices: vi.fn().mockResolvedValue(new Map()),
		fetchMarketStatus: fetchMarketStatusMock,
	};
});

vi.mock("../../../src/lib/time/market-calendar", async () => {
	const actual = await vi.importActual("../../../src/lib/time/market-calendar");
	return {
		...actual,
		getUsMarketClosureInfoForInstant: getUsMarketClosureInfoForInstantMock,
	};
});

vi.mock("../../../src/lib/market-notifications/scheduled/process", () => ({
	processMarketScheduledUser: vi.fn(),
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
		},
		deliveredUserTypes: new Set<string>(),
	}),
}));

vi.mock("../../../src/lib/staged-notifications/precompute", () => ({
	precomputeMarketScheduled: vi.fn().mockResolvedValue({
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	}),
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

vi.mock("../../../src/lib/schedule/sms-sender", () => ({
	createSmsSenderProvider: () => () => ({ sender: "+15555550123" }),
}));

vi.mock("../../../src/lib/market-notifications/snapshot-store", () => ({
	purgeOldAssetSnapshots: vi.fn().mockResolvedValue(0),
}));

describe("A cron fallback pass fans out daily digests without a shared closure label.", () => {
	beforeEach(() => {
		dispatchDailyDigestUserMock.mockReset();
		fetchDailyDigestUsersMock.mockReset();
		fetchMarketScheduledUsersMock.mockReset();
		fetchAssetEventsUsersMock.mockReset();
		fetchMarketStatusMock.mockReset();
		processPriceAlertsMock.mockReset();
		processPriceTargetsMock.mockReset();
		getUsMarketClosureInfoForInstantMock.mockReset();
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");

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
			isMarketOpen: undefined,
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
		const { runScheduledNotifications } = await import(
			"../../../src/lib/schedule/run"
		);

		fetchDailyDigestUsersMock.mockResolvedValueOnce([{ id: "daily-user-1" }]);
		fetchMarketScheduledUsersMock.mockResolvedValue([]);
		fetchAssetEventsUsersMock
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		fetchDailyDigestUsersMock.mockResolvedValueOnce([]);
		fetchMarketScheduledUsersMock.mockResolvedValueOnce([]);
		fetchMarketStatusMock.mockResolvedValue(false);
		getUsMarketClosureInfoForInstantMock.mockResolvedValue({
			reason: "weekend",
		});
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		await runScheduledNotifications({
			supabase: {} as never,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			} as never,
			forceSend: false,
			cronSecret: "cron-secret",
		});

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
	});
});
