import { describe, expect, it, vi } from "vitest";
import {
	type DailyStatsRow,
	upsertDailyStatsInChunks,
} from "../../../src/lib/market-notifications/daily-stats-upsert";

function row(symbol: string): DailyStatsRow {
	return { symbol, computed_at: "2026-06-13", avg_volume_20d: 1_000_000, atr_14: 1.2345 };
}

describe("upsertDailyStatsInChunks", () => {
	it("A clean run upserts every chunk and reports zero failures", async () => {
		const rows = ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"].map(row);
		const upsert = vi.fn(async () => ({ error: null }));

		const result = await upsertDailyStatsInChunks(rows, upsert, 2);

		expect(result).toEqual({ upserted: 5, failedChunks: 0, failedRows: 0 });
		expect(upsert).toHaveBeenCalledTimes(3); // 2 + 2 + 1
	});

	it("A single failing chunk does not discard the chunks that succeeded", async () => {
		const rows = ["AAPL", "MSFT", "NVDA", "TSLA"].map(row);
		const upsert = vi
			.fn()
			.mockResolvedValueOnce({ error: null })
			.mockResolvedValueOnce({ error: { message: "deadlock" } });

		const result = await upsertDailyStatsInChunks(rows, upsert, 2);

		expect(result).toEqual({ upserted: 2, failedChunks: 1, failedRows: 2 });
	});
});
