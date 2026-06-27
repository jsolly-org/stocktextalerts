import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchInsiderTransactions,
	fetchRecommendationTrends,
} from "../../../src/lib/asset-events/enrichment";
import {
	ANALYST_FRESHNESS_MS,
	fetchAndStoreFinnhubEnrichment,
	loadStoredFinnhubExtras,
} from "../../../src/lib/asset-events/enrichment-store";

vi.mock("../../../src/lib/asset-events/enrichment", () => ({
	fetchRecommendationTrends: vi.fn(),
	fetchInsiderTransactions: vi.fn(),
}));

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("fetchAndStoreFinnhubEnrichment", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("upserts analyst and insider rows for tracked symbols", async () => {
		vi.mocked(fetchRecommendationTrends).mockResolvedValue({
			trend: {
				buy: 10,
				hold: 5,
				sell: 1,
				strongBuy: 2,
				strongSell: 0,
				period: "2026-02-01",
			},
			httpSucceeded: true,
		});
		vi.mocked(fetchInsiderTransactions).mockResolvedValue([
			{
				name: "Jane Doe",
				share: 1000,
				change: 500,
				transactionType: "P",
				transactionDate: "2026-02-10",
			},
		]);

		const analystRows: Array<Record<string, unknown>> = [];
		const insiderRows: Array<Record<string, unknown>> = [];

		const supabase = {
			from(table: string) {
				if (table === "user_assets") {
					return {
						select() {
							return Promise.resolve({ data: [{ symbol: "AAPL" }], error: null });
						},
					};
				}
				if (table === "asset_analyst_consensus") {
					return {
						upsert(row: Record<string, unknown>) {
							analystRows.push(row);
							return Promise.resolve({ error: null });
						},
					};
				}
				if (table === "asset_insider_transactions") {
					return {
						upsert(rows: Record<string, unknown>[]) {
							insiderRows.push(...rows);
							return Promise.resolve({ error: null });
						},
						delete() {
							return {
								lt() {
									return Promise.resolve({ error: null });
								},
							};
						},
					};
				}
				throw new Error(`Unexpected table: ${table}`);
			},
		};

		const result = await fetchAndStoreFinnhubEnrichment({
			supabase: supabase as never,
			logger: logger as never,
		});

		expect(result.analystUpserted).toBe(1);
		expect(result.insiderUpserted).toBe(1);
		expect(analystRows[0]?.symbol).toBe("AAPL");
		expect(analystRows[0]?.fetch_succeeded).toBe(true);
		expect(insiderRows[0]?.symbol).toBe("AAPL");
		expect(fetchRecommendationTrends).toHaveBeenCalledWith("AAPL", { optional: true });
	});

	it("dedupes duplicate insider rows before upsert", async () => {
		vi.mocked(fetchRecommendationTrends).mockResolvedValue({
			trend: null,
			httpSucceeded: true,
		});
		vi.mocked(fetchInsiderTransactions).mockResolvedValue([
			{
				name: "Jane Doe",
				share: 1000,
				change: 500,
				transactionType: "P",
				transactionDate: "2026-02-10",
			},
			{
				name: "Jane Doe",
				share: 2000,
				change: 500,
				transactionType: "S",
				transactionDate: "2026-02-10",
			},
		]);

		const insiderRows: Array<Record<string, unknown>> = [];

		const supabase = {
			from(table: string) {
				if (table === "user_assets") {
					return {
						select() {
							return Promise.resolve({ data: [{ symbol: "AAPL" }], error: null });
						},
					};
				}
				if (table === "asset_analyst_consensus") {
					return {
						select() {
							return {
								eq() {
									return { maybeSingle: () => Promise.resolve({ data: null, error: null }) };
								},
							};
						},
						insert() {
							return Promise.resolve({ error: null });
						},
					};
				}
				if (table === "asset_insider_transactions") {
					return {
						upsert(rows: Record<string, unknown>[]) {
							insiderRows.push(...rows);
							return Promise.resolve({ error: null });
						},
						delete() {
							return { lt: () => Promise.resolve({ error: null }) };
						},
					};
				}
				throw new Error(`Unexpected table: ${table}`);
			},
		};

		const result = await fetchAndStoreFinnhubEnrichment({
			supabase: supabase as never,
			logger: logger as never,
		});

		expect(result.insiderUpserted).toBe(1);
		expect(result.enrichmentFailures).not.toContain("insider_upsert:AAPL");
		expect(insiderRows).toHaveLength(1);
		expect(insiderRows[0]?.share).toBe(2000);
		expect(insiderRows[0]?.transaction_type).toBe("S");
	});

	it("logs bounded payload context when insider upsert fails", async () => {
		vi.mocked(fetchRecommendationTrends).mockResolvedValue({
			trend: null,
			httpSucceeded: true,
		});
		vi.mocked(fetchInsiderTransactions).mockResolvedValue([
			{
				name: "Jane Doe",
				share: 1000,
				change: 500,
				transactionType: "P",
				transactionDate: "2026-02-10",
			},
		]);

		const upsertError = {
			code: "21000",
			message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
		};

		const supabase = {
			from(table: string) {
				if (table === "user_assets") {
					return {
						select() {
							return Promise.resolve({ data: [{ symbol: "AAPL" }], error: null });
						},
					};
				}
				if (table === "asset_analyst_consensus") {
					return {
						select() {
							return {
								eq() {
									return { maybeSingle: () => Promise.resolve({ data: null, error: null }) };
								},
							};
						},
						insert() {
							return Promise.resolve({ error: null });
						},
					};
				}
				if (table === "asset_insider_transactions") {
					return {
						upsert() {
							return Promise.resolve({ error: upsertError });
						},
						delete() {
							return { lt: () => Promise.resolve({ error: null }) };
						},
					};
				}
				throw new Error(`Unexpected table: ${table}`);
			},
		};

		await fetchAndStoreFinnhubEnrichment({
			supabase: supabase as never,
			logger: logger as never,
		});

		expect(logger.error).toHaveBeenCalled();
		const errorContext = vi.mocked(logger.error).mock.calls[0]?.[1] as Record<string, unknown>;
		expect(errorContext.symbol).toBe("AAPL");
		expect(errorContext.rawRowCount).toBe(1);
		expect(errorContext.dedupedRowCount).toBe(1);
		expect(errorContext.proposedRowsMode).toBe("full");
	});

	it("records enrichment failure when analyst HTTP does not succeed", async () => {
		vi.mocked(fetchRecommendationTrends).mockResolvedValue({
			trend: null,
			httpSucceeded: false,
		});
		vi.mocked(fetchInsiderTransactions).mockResolvedValue([]);

		const supabase = {
			from(table: string) {
				if (table === "user_assets") {
					return {
						select() {
							return Promise.resolve({ data: [{ symbol: "AAPL" }], error: null });
						},
					};
				}
				if (table === "asset_insider_transactions") {
					return {
						delete() {
							return { lt: () => Promise.resolve({ error: null }) };
						},
					};
				}
				throw new Error(`Unexpected table: ${table}`);
			},
		};

		const result = await fetchAndStoreFinnhubEnrichment({
			supabase: supabase as never,
			logger: logger as never,
		});

		expect(result.enrichmentFailures).toContain("analyst:AAPL");
		expect(result.analystUpserted).toBe(0);
	});
});

describe("loadStoredFinnhubExtras", () => {
	it("treats stale analyst rows as fetch failure for monthly tracking", async () => {
		const staleFetchedAt = new Date(Date.now() - ANALYST_FRESHNESS_MS - 60_000).toISOString();

		const supabase = {
			from(table: string) {
				if (table === "asset_analyst_consensus") {
					return {
						select() {
							return {
								in() {
									return Promise.resolve({
										data: [
											{
												symbol: "AAPL",
												period: "2026-01-01",
												buy: 1,
												hold: 1,
												sell: 1,
												strong_buy: 1,
												strong_sell: 1,
												fetch_succeeded: true,
												fetched_at: staleFetchedAt,
											},
										],
										error: null,
									});
								},
							};
						},
					};
				}
				throw new Error(`Unexpected table: ${table}`);
			},
		};

		const result = await loadStoredFinnhubExtras({
			supabase: supabase as never,
			logger: logger as never,
			tickers: ["AAPL"],
			localDate: "2026-02-10",
			includeAnalyst: true,
			includeInsider: false,
		});

		expect(result.analystFetchSucceeded).toBe(false);
		expect(result.analyst.get("AAPL")).toBeNull();
	});
});
