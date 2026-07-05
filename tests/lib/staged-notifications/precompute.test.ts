import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { precomputeDailyDigest } from "../../../src/lib/staged-notifications/precompute";

const {
	dispatchDailyDigestUserMock,
	fetchAssetPricesWithSessionStateMock,
	fetchIntradaySparklinesMock,
	fetchSparklinesMock,
	fetchUpcomingDailyDigestUsersMock,
	getCurrentMarketSessionMock,
} = vi.hoisted(() => ({
	dispatchDailyDigestUserMock: vi.fn(),
	fetchAssetPricesWithSessionStateMock: vi.fn(),
	fetchIntradaySparklinesMock: vi.fn(),
	fetchSparklinesMock: vi.fn(),
	fetchUpcomingDailyDigestUsersMock: vi.fn(),
	getCurrentMarketSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/time/market/calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
	fetchUpcomingDailyDigestUsers: fetchUpcomingDailyDigestUsersMock,
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

vi.mock("../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/sparklines")>(
		"../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
		fetchIntradaySparklines: fetchIntradaySparklinesMock,
		fetchSparklines: fetchSparklinesMock,
	};
});

describe("A cron job precomputes daily digest content for upcoming users.", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("leaves market-closure classification to each user's scheduled instant", async () => {
		const currentTime = DateTime.fromISO("2026-03-22T03:59:50.000Z", {
			zone: "utc",
		});
		const currentTimeIso = currentTime.toISO();
		if (!currentTimeIso) {
			throw new Error("Expected valid currentTime ISO string");
		}

		fetchUpcomingDailyDigestUsersMock.mockResolvedValue([
			{ id: "10000000-0000-4000-a000-000000000001" },
			{ id: "10000000-0000-4000-a000-000000000002" },
		]);
		getCurrentMarketSessionMock.mockResolvedValue("closed");
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
		});

		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await precomputeDailyDigest({
			supabase: {} as never,
			logger: logger as never,
			currentTime,
		});

		expect(dispatchDailyDigestUserMock).toHaveBeenCalledTimes(2);

		for (const [args] of dispatchDailyDigestUserMock.mock.calls) {
			expect(args).toMatchObject({
				currentTimeIso,
				precompute: true,
				marketOpen: false,
			});
			expect(args).not.toHaveProperty("marketClosureInfo");
		}
	});

	it("uses scheduler-provided marketOpen without calling Massive market status again", async () => {
		const currentTime = DateTime.fromISO("2026-06-01T13:55:00.000Z", { zone: "utc" });
		fetchUpcomingDailyDigestUsersMock.mockResolvedValue([
			{ id: "10000000-0000-4000-a000-000000000004" },
		]);
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
		});

		await precomputeDailyDigest({
			supabase: {} as never,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			currentTime,
			marketOpen: true,
		});

		expect(getCurrentMarketSessionMock).not.toHaveBeenCalled();
		expect(dispatchDailyDigestUserMock).toHaveBeenCalledWith(
			expect.objectContaining({ marketOpen: true, precompute: true }),
		);
	});
});
