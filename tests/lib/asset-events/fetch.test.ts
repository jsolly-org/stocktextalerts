import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAndStoreAssetEvents } from "../../../src/lib/asset-events/fetch";
import {
	fetchDividends,
	fetchEarnings,
	fetchIpos,
	fetchSplits,
} from "../../../src/lib/providers/massive";

vi.mock("../../../src/lib/providers/massive", () => ({
	fetchEarnings: vi.fn(),
	fetchDividends: vi.fn(),
	fetchSplits: vi.fn(),
	fetchIpos: vi.fn(),
}));

type AssetEventRow = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split" | "ipo";
	scope: "watchlist" | "global";
	event_date: string;
	data: Record<string, unknown>;
	week_of: string;
};

function createSupabaseStub(trackedSymbols: string[]) {
	const state: { upsertRows: AssetEventRow[] } = { upsertRows: [] };

	const supabase = {
		from(table: string) {
			if (table === "user_assets") {
				return {
					select() {
						return Promise.resolve({
							data: trackedSymbols.map((symbol) => ({ symbol })),
							error: null,
						});
					},
				};
			}

			if (table === "asset_events") {
				return {
					upsert(rows: AssetEventRow[]) {
						state.upsertRows = rows;
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

	return { supabase, state };
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("fetchAndStoreAssetEvents", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("stores IPO events even when no symbols are tracked", async () => {
		const { supabase, state } = createSupabaseStub([]);

		vi.mocked(fetchEarnings).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchDividends).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchIpos).mockResolvedValue({
			data: [
				{
					ticker: "ACME",
					listingDate: "2026-02-16",
					issuerName: "Acme Corp",
					securityType: "CS",
				},
			],
			failed: false,
		});

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ upserted: 1, failedProviders: [] });
		expect(state.upsertRows).toHaveLength(1);
		expect(state.upsertRows[0]).toMatchObject({
			symbol: "ACME",
			event_type: "ipo",
			scope: "global",
			event_date: "2026-02-16",
		});
	});

	it("keeps calendar events watchlist-scoped while IPOs stay global", async () => {
		const { supabase, state } = createSupabaseStub(["AAPL"]);

		vi.mocked(fetchEarnings).mockResolvedValue({
			data: [
				{
					ticker: "AAPL",
					date: "2026-02-16",
					time: null,
					epsEstimate: null,
					revenueEstimate: null,
				},
				{
					ticker: "MSFT",
					date: "2026-02-16",
					time: null,
					epsEstimate: null,
					revenueEstimate: null,
				},
			],
			failed: false,
		});
		vi.mocked(fetchDividends).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchIpos).mockResolvedValue({
			data: [
				{
					ticker: "AAPL",
					listingDate: "2026-02-17",
					issuerName: "Apple Spinout",
					securityType: "CS",
				},
				{
					ticker: "NEWC",
					listingDate: "2026-02-18",
					issuerName: "NewCo",
					securityType: "CS",
				},
			],
			failed: false,
		});

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ upserted: 3, failedProviders: [] });
		expect(state.upsertRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					symbol: "AAPL",
					event_type: "earnings",
					scope: "watchlist",
				}),
				expect.objectContaining({
					symbol: "AAPL",
					event_type: "ipo",
					scope: "global",
				}),
				expect.objectContaining({
					symbol: "NEWC",
					event_type: "ipo",
					scope: "global",
				}),
			]),
		);
		expect(
			state.upsertRows.some(
				(row) => row.symbol === "MSFT" && row.event_type === "earnings",
			),
		).toBe(false);
	});

	it("succeeds on repeated calls (upsert idempotency)", async () => {
		const { supabase } = createSupabaseStub(["AAPL"]);

		vi.mocked(fetchEarnings).mockResolvedValue({
			data: [
				{
					ticker: "AAPL",
					date: "2026-02-16",
					time: null,
					epsEstimate: null,
					revenueEstimate: null,
				},
			],
			failed: false,
		});
		vi.mocked(fetchDividends).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchIpos).mockResolvedValue({ data: [], failed: false });

		const args = {
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		};

		const first = await fetchAndStoreAssetEvents(args);
		const second = await fetchAndStoreAssetEvents(args);

		expect(first).toEqual({ upserted: 1, failedProviders: [] });
		expect(second).toEqual({ upserted: 1, failedProviders: [] });
	});

	it("reports single provider failure while storing other data", async () => {
		const { supabase, state } = createSupabaseStub(["AAPL"]);

		vi.mocked(fetchEarnings).mockResolvedValue({ data: [], failed: true });
		vi.mocked(fetchDividends).mockResolvedValue({
			data: [
				{
					ticker: "AAPL",
					exDividendDate: "2026-02-17",
					cashAmount: 0.25,
					currency: "USD",
					payDate: null,
					frequency: 4,
				},
			],
			failed: false,
		});
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchIpos).mockResolvedValue({ data: [], failed: false });

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ upserted: 1, failedProviders: ["earnings"] });
		expect(state.upsertRows).toHaveLength(1);
		expect(state.upsertRows[0]).toMatchObject({
			symbol: "AAPL",
			event_type: "dividend",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			"One or more asset event providers failed",
			expect.objectContaining({ failedProviders: ["earnings"] }),
		);
	});

	it("reports all providers failed with 0 upserted", async () => {
		const { supabase } = createSupabaseStub(["AAPL"]);

		vi.mocked(fetchEarnings).mockResolvedValue({ data: [], failed: true });
		vi.mocked(fetchDividends).mockResolvedValue({ data: [], failed: true });
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: true });
		vi.mocked(fetchIpos).mockResolvedValue({ data: [], failed: true });

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({
			upserted: 0,
			failedProviders: ["earnings", "dividends", "splits", "ipos"],
		});
		expect(logger.warn).toHaveBeenCalledWith(
			"One or more asset event providers failed",
			expect.objectContaining({
				failedProviders: ["earnings", "dividends", "splits", "ipos"],
			}),
		);
	});

	it("returns empty failedProviders and does not warn when all succeed", async () => {
		const { supabase } = createSupabaseStub(["AAPL"]);

		vi.mocked(fetchEarnings).mockResolvedValue({
			data: [
				{
					ticker: "AAPL",
					date: "2026-02-16",
					time: null,
					epsEstimate: null,
					revenueEstimate: null,
				},
			],
			failed: false,
		});
		vi.mocked(fetchDividends).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchSplits).mockResolvedValue({ data: [], failed: false });
		vi.mocked(fetchIpos).mockResolvedValue({ data: [], failed: false });

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ upserted: 1, failedProviders: [] });
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
