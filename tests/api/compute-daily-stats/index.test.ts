import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeADV,
	computeATR,
	type DailyOHLCVBar,
} from "../../../src/lib/market-notifications/daily-stats";
import { GET as runComputeDailyStatsCron } from "../../../src/pages/api/compute-daily-stats";
import { createApiContext } from "../../helpers/api-context";
import { createCronRequest } from "../../helpers/cron";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const { fetchDailyOHLCVMock } = vi.hoisted(() => ({
	fetchDailyOHLCVMock: vi.fn(),
}));

vi.mock("../../../src/lib/providers/massive", () => ({
	fetchDailyOHLCV: fetchDailyOHLCVMock,
}));

function makeBars(baseClose: number, baseVolume: number): DailyOHLCVBar[] {
	return Array.from({ length: 20 }, (_, index) => {
		const close = baseClose + index * 0.45;
		return {
			open: close - 0.32,
			high: close + 1.18,
			low: close - 1.09,
			close,
			volume: baseVolume + index * 85_000,
		};
	});
}

describe("A nightly cron computes and persists shared daily stats for tracked symbols.", () => {
	const testCronSecret = "compute-daily-stats-test-secret";
	const aaplBars = makeBars(187.42, 6_200_000);
	const msftBars = makeBars(421.35, 5_400_000);

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-14T22:00:00.000Z"));
		vi.stubEnv("CRON_SECRET", testCronSecret);
		fetchDailyOHLCVMock.mockReset();
		const { error } = await adminClient
			.from("daily_asset_stats")
			.delete()
			.in("symbol", ["AAPL", "MSFT"]);
		expect(error).toBeNull();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		const { error } = await adminClient
			.from("daily_asset_stats")
			.delete()
			.in("symbol", ["AAPL", "MSFT"]);
		expect(error).toBeNull();
	});

	it("Computes one shared AAPL stats row even when multiple users track the same symbol.", async () => {
		const eastUser = await createTestUser({
			timezone: "America/New_York",
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(eastUser.id);

		const westUser = await createTestUser({
			timezone: "America/Los_Angeles",
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(westUser.id);

		fetchDailyOHLCVMock.mockResolvedValue(aaplBars);

		const response = await runComputeDailyStatsCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/compute-daily-stats",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { computed: number; failed: number };
		expect(payload).toEqual({ computed: 1, failed: 0 });

		expect(fetchDailyOHLCVMock).toHaveBeenCalledTimes(1);
		expect(fetchDailyOHLCVMock).toHaveBeenCalledWith(
			"AAPL",
			expect.any(String),
			expect.any(String),
		);

		const expectedAdv = computeADV(aaplBars);
		const expectedAtr = computeATR(aaplBars);
		expect(expectedAdv).not.toBeNull();
		expect(expectedAtr).not.toBeNull();

		const { data: statsRow, error: statsError } = await adminClient
			.from("daily_asset_stats")
			.select("symbol,computed_at,avg_volume_20d,atr_14")
			.eq("symbol", "AAPL")
			.single();
		expect(statsError).toBeNull();
		expect(statsRow?.symbol).toBe("AAPL");
		expect(statsRow?.computed_at).toBe("2026-01-14");
		expect(statsRow?.avg_volume_20d).toBe(Math.round(expectedAdv ?? 0));
		expect(Number(statsRow?.atr_14)).toBeCloseTo(
			Math.round((expectedAtr ?? 0) * 10_000) / 10_000,
			4,
		);
	});

	it("Continues upserting successful symbols when another tracked symbol has no usable bars.", async () => {
		const testUser = await createTestUser({
			timezone: "America/New_York",
			trackedAssets: ["AAPL", "MSFT"],
		});
		registerTestUserForCleanup(testUser.id);

		fetchDailyOHLCVMock.mockImplementation(
			async (symbol: string): Promise<DailyOHLCVBar[] | null> => {
				if (symbol === "AAPL") return aaplBars;
				if (symbol === "MSFT") return null;
				return msftBars;
			},
		);

		const response = await runComputeDailyStatsCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/compute-daily-stats",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { computed: number; failed: number };
		expect(payload).toEqual({ computed: 1, failed: 1 });
		expect(fetchDailyOHLCVMock).toHaveBeenCalledTimes(2);

		const { data: rows, error: rowsError } = await adminClient
			.from("daily_asset_stats")
			.select("symbol")
			.in("symbol", ["AAPL", "MSFT"]);
		expect(rowsError).toBeNull();
		const symbols = new Set((rows ?? []).map((row) => row.symbol));
		expect(symbols.has("AAPL")).toBe(true);
		expect(symbols.has("MSFT")).toBe(false);
	});
});
