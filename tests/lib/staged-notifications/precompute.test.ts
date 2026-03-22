import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { precomputeDailyDigest } from "../../../src/lib/staged-notifications/precompute";

const {
	dispatchDailyDigestUserMock,
	fetchUpcomingDailyDigestUsersMock,
	fetchMarketStatusMock,
} = vi.hoisted(() => ({
	dispatchDailyDigestUserMock: vi.fn(),
	fetchUpcomingDailyDigestUsersMock: vi.fn(),
	fetchMarketStatusMock: vi.fn(),
}));

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
	fetchUpcomingDailyDigestUsers: fetchUpcomingDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual(
		"../../../src/lib/providers/price-fetcher",
	);
	return {
		...actual,
		fetchMarketStatus: fetchMarketStatusMock,
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
		fetchMarketStatusMock.mockResolvedValue(false);
		dispatchDailyDigestUserMock.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
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
			cronSecret: "test-secret",
		});

		expect(dispatchDailyDigestUserMock).toHaveBeenCalledTimes(2);

		for (const [args] of dispatchDailyDigestUserMock.mock.calls) {
			expect(args).toMatchObject({
				currentTimeIso,
				cronSecret: "test-secret",
				precompute: true,
				marketOpen: false,
			});
			expect(args).not.toHaveProperty("marketClosureInfo");
		}
	});
});
