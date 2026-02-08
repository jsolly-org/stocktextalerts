import { describe, expect, it } from "vitest";
import { MAX_TRACKED_STOCKS } from "../../../src/lib/db/database-errors";
import { rootLogger } from "../../../src/lib/logging";
import { getRealStockSymbols, getStockData } from "../../helpers/stock-data";
import { updateTrackedStocks } from "../../helpers/stock-update";
import { adminClient } from "../../helpers/test-env";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user updates their tracked stocks.", () => {
	it("A user cannot track more than the maximum allowed stocks.", async () => {
		const seedSymbols = getRealStockSymbols(MAX_TRACKED_STOCKS + 1);
		const seedRecords = seedSymbols.map((symbol) => {
			const stockData = getStockData(symbol);
			return {
				symbol: stockData.symbol,
				name: stockData.name,
				exchange: stockData.exchange,
			};
		});

		const { error: insertError } = await adminClient
			.from("stocks")
			.upsert(seedRecords, { onConflict: "symbol" });
		expect(insertError).toBeNull();

		try {
			const initialStocks = seedSymbols.slice(0, MAX_TRACKED_STOCKS);
			const stocksExceedingLimit = seedSymbols.slice(0, MAX_TRACKED_STOCKS + 1);

			const { response, trackedStocks, payload } = await updateTrackedStocks(
				initialStocks,
				stocksExceedingLimit,
				{},
				registerTestUserForCleanup,
			);

			expect(response.status).toBe(400);
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("stocks_limit");

			expect(trackedStocks).toHaveLength(MAX_TRACKED_STOCKS);
		} finally {
			const { error: stockDeleteError } = await adminClient
				.from("stocks")
				.delete()
				.in("symbol", seedSymbols);
			if (stockDeleteError) {
				rootLogger.warn("Cleanup failed (stocks)", { error: stockDeleteError });
			}
		}
	});

	it("A user with no tracked stocks adds their first stock.", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			[],
			["AAPL"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(1);
		expect(trackedStocks?.[0]?.symbol).toBe("AAPL");
	});

	it("A user with one tracked stock removes it.", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL"],
			[],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(0);
	});

	it("A user with one tracked stock adds another.", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL"],
			["AAPL", "MSFT"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("A user replaces their tracked stocks with a new set.", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["TSLA", "NVDA"],
			["AAPL", "MSFT"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(2);
		expect(trackedStocks?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("A user clears all tracked stocks.", async () => {
		const { response, trackedStocks, payload } = await updateTrackedStocks(
			["AAPL", "MSFT", "GOOGL"],
			[],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("stocks_updated");

		expect(trackedStocks).toHaveLength(0);
	});
});
