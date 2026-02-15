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
					select(
						_columns: string,
						options?: { count?: "exact"; head?: boolean },
					) {
						if (options?.count === "exact" && options.head === true) {
							return {
								eq() {
									return Promise.resolve({ count: 0, error: null });
								},
							};
						}
						throw new Error("Unexpected select() shape in test stub");
					},
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

		vi.mocked(fetchEarnings).mockResolvedValue([]);
		vi.mocked(fetchDividends).mockResolvedValue([]);
		vi.mocked(fetchSplits).mockResolvedValue([]);
		vi.mocked(fetchIpos).mockResolvedValue([
			{
				ticker: "ACME",
				listingDate: "2026-02-16",
				issuerName: "Acme Corp",
				securityType: "CS",
			},
		]);

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ inserted: 1, skipped: false });
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

		vi.mocked(fetchEarnings).mockResolvedValue([
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
		]);
		vi.mocked(fetchDividends).mockResolvedValue([]);
		vi.mocked(fetchSplits).mockResolvedValue([]);
		vi.mocked(fetchIpos).mockResolvedValue([
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
		]);

		const result = await fetchAndStoreAssetEvents({
			supabase: supabase as never,
			weekStart: "2026-02-16",
			weekEnd: "2026-02-20",
			logger: logger as never,
		});

		expect(result).toEqual({ inserted: 3, skipped: false });
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
});
