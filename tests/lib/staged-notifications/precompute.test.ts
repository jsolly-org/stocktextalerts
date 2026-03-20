import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
	fetchUpcomingDailyDigestUsers: vi.fn(),
}));

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
	dispatchDailyDigestUser: vi.fn(),
}));

vi.mock("../../../src/lib/providers/price-fetcher", () => ({
	fetchAssetPrices: vi.fn(),
	fetchMarketStatus: vi.fn(),
}));

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn(),
}));

import { dispatchDailyDigestUser } from "../../../src/lib/daily-digest/dispatch";
import { fetchUpcomingDailyDigestUsers } from "../../../src/lib/daily-digest/query-upcoming";
import { createLogger } from "../../../src/lib/logging";
import { fetchMarketStatus } from "../../../src/lib/providers/price-fetcher";
import { precomputeDailyDigest } from "../../../src/lib/staged-notifications/precompute";
import { getUsMarketClosureInfoForInstant } from "../../../src/lib/time/market-calendar";

describe("precomputeDailyDigest", () => {
	it("A precompute run near US midnight lets each worker derive closure info from the scheduled send instant.", async () => {
		const mockedFetchUpcomingDailyDigestUsers = vi.mocked(
			fetchUpcomingDailyDigestUsers,
		);
		const mockedDispatchDailyDigestUser = vi.mocked(dispatchDailyDigestUser);
		const mockedFetchMarketStatus = vi.mocked(fetchMarketStatus);
		const mockedGetUsMarketClosureInfoForInstant = vi.mocked(
			getUsMarketClosureInfoForInstant,
		);

		mockedFetchUpcomingDailyDigestUsers.mockResolvedValue([
			{ id: "00000000-0000-0000-0000-000000000001" } as never,
		]);
		mockedFetchMarketStatus.mockResolvedValue(false);
		mockedGetUsMarketClosureInfoForInstant.mockResolvedValue({
			reason: "holiday",
			holidayName: "Observed Holiday",
		});
		mockedDispatchDailyDigestUser.mockResolvedValue({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		const logger = createLogger({ path: "precompute-daily-test" });
		const stats = await precomputeDailyDigest({
			supabase: {} as never,
			logger,
			currentTime: DateTime.fromISO("2026-01-05T04:59:45.000Z"),
			cronSecret: "test-cron-secret",
		});

		expect(stats).toEqual({
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
		expect(mockedGetUsMarketClosureInfoForInstant).not.toHaveBeenCalled();
		expect(mockedDispatchDailyDigestUser).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "00000000-0000-0000-0000-000000000001",
				currentTimeIso: "2026-01-05T04:59:45.000+00:00",
				cronSecret: "test-cron-secret",
				precompute: true,
				marketOpen: false,
			}),
		);
	});
});
