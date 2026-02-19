import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiContext } from "../helpers/api-context";
import { createCronRequest } from "../helpers/cron";
import { allowConsoleErrors, allowConsoleWarnings } from "../setup";

type QueryRow = { symbol: string };
type UpdateCall = {
	payload: Record<string, unknown>;
	column: string;
	value: unknown;
};

const state: {
	queryRows: QueryRow[];
	queryError: { message: string } | null;
	updateCalls: UpdateCall[];
	updateErrorForSymbol: string | null;
} = {
	queryRows: [],
	queryError: null,
	updateCalls: [],
	updateErrorForSymbol: null,
};

const { createSupabaseAdminClientMock, marketDataFetchMock } = vi.hoisted(
	() => ({
		createSupabaseAdminClientMock: vi.fn(),
		marketDataFetchMock: vi.fn(),
	}),
);

vi.mock("../../src/lib/db/supabase", () => ({
	createSupabaseAdminClient: createSupabaseAdminClientMock,
}));

vi.mock("../../src/lib/providers/massive", () => ({
	marketDataFetch: marketDataFetchMock,
}));

async function loadSectorBackfillHandler() {
	const module = await import("../../src/pages/api/sector-backfill");
	return module.GET;
}

describe("A cron worker backfills missing asset sectors.", () => {
	const testCronSecret = "sector-backfill-test-secret";

	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("CRON_SECRET", testCronSecret);
		state.queryRows = [];
		state.queryError = null;
		state.updateCalls = [];
		state.updateErrorForSymbol = null;
		createSupabaseAdminClientMock.mockReset();
		marketDataFetchMock.mockReset();

		const mockSupabase = {
			from: (table: string) => {
				if (table !== "assets") {
					throw new Error(`Unexpected table in test mock: ${table}`);
				}

				return {
					select: () => ({
						is: () => ({
							limit: async () =>
								state.queryError
									? { data: null, error: state.queryError }
									: { data: state.queryRows, error: null },
						}),
					}),
					update: (payload: Record<string, unknown>) => ({
						eq: async (column: string, value: unknown) => {
							state.updateCalls.push({ payload, column, value });
							const failForSymbol = state.updateErrorForSymbol;
							const symbol = String(value);
							return failForSymbol === symbol
								? { error: { message: "Constraint violation" } }
								: { error: null };
						},
					}),
				};
			},
		};

		createSupabaseAdminClientMock.mockReturnValue(mockSupabase);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("Fills sector values from ticker details when assets are missing sectors.", async () => {
		state.queryRows = [{ symbol: "AAPL" }, { symbol: "XOM" }];
		marketDataFetchMock
			.mockResolvedValueOnce({ results: { sic_code: "3571" } }) // Technology
			.mockResolvedValueOnce({ results: { sic_code: "1311" } }); // Energy

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(marketDataFetchMock).toHaveBeenCalledTimes(2);
		expect(state.updateCalls).toEqual([
			{
				payload: { sector: "Technology" },
				column: "symbol",
				value: "AAPL",
			},
			{
				payload: { sector: "Energy" },
				column: "symbol",
				value: "XOM",
			},
		]);

		const payload = (await response.json()) as {
			success: boolean;
			updated: number;
			skipped: number;
		};
		expect(payload.success).toBe(true);
		expect(payload.updated).toBe(2);
		expect(payload.skipped).toBe(0);
	});

	it("Returns a no-op response when no assets need backfill.", async () => {
		state.queryRows = [];

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(marketDataFetchMock).not.toHaveBeenCalled();
		expect(state.updateCalls).toHaveLength(0);

		const payload = (await response.json()) as {
			success: boolean;
			updated: number;
			skipped: number;
		};
		expect(payload.success).toBe(true);
		expect(payload.updated).toBe(0);
		expect(payload.skipped).toBe(0);
	});

	it("Rejects a cron request without authorization.", async () => {
		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: new Request("http://localhost/api/sector-backfill", {
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(401);
		expect(createSupabaseAdminClientMock).not.toHaveBeenCalled();
	});

	it("Returns 500 when the database query for assets fails.", async () => {
		allowConsoleErrors();
		state.queryError = { message: "Connection refused" };

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(500);
		const payload = (await response.json()) as {
			success: boolean;
			error: string;
		};
		expect(payload.success).toBe(false);
		expect(payload.error).toBe("Connection refused");
		expect(marketDataFetchMock).not.toHaveBeenCalled();
	});

	it("Skips assets when market data fetch fails and reports skipped count.", async () => {
		allowConsoleWarnings();
		state.queryRows = [{ symbol: "AAPL" }, { symbol: "XOM" }];
		marketDataFetchMock
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockResolvedValueOnce({ results: { sic_code: "1311" } });

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			success: boolean;
			updated: number;
			skipped: number;
		};
		expect(payload.success).toBe(true);
		expect(payload.updated).toBe(1);
		expect(payload.skipped).toBe(1);
		expect(state.updateCalls).toHaveLength(1);
		expect(state.updateCalls[0]).toEqual({
			payload: { sector: "Energy" },
			column: "symbol",
			value: "XOM",
		});
	});

	it("Skips assets when database update fails and reports skipped count.", async () => {
		allowConsoleWarnings();
		state.queryRows = [{ symbol: "AAPL" }, { symbol: "XOM" }];
		state.updateErrorForSymbol = "AAPL";
		marketDataFetchMock
			.mockResolvedValueOnce({ results: { sic_code: "3571" } })
			.mockResolvedValueOnce({ results: { sic_code: "1311" } });

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			success: boolean;
			updated: number;
			skipped: number;
		};
		expect(payload.success).toBe(true);
		expect(payload.updated).toBe(1);
		expect(payload.skipped).toBe(1);
		expect(state.updateCalls).toHaveLength(2);
		expect(state.updateCalls[0].payload).toEqual({ sector: "Technology" });
		expect(state.updateCalls[1].payload).toEqual({ sector: "Energy" });
	});

	it("Maps unknown SIC codes to Other and updates the asset.", async () => {
		state.queryRows = [{ symbol: "OBSCURE" }];
		marketDataFetchMock.mockResolvedValueOnce({
			results: { sic_code: "99999" },
		});

		const runSectorBackfill = await loadSectorBackfillHandler();
		const response = await runSectorBackfill(
			createApiContext({
				request: createCronRequest({
					path: "/api/sector-backfill",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			success: boolean;
			updated: number;
			skipped: number;
		};
		expect(payload.success).toBe(true);
		expect(payload.updated).toBe(1);
		expect(payload.skipped).toBe(0);
		expect(state.updateCalls).toEqual([
			{
				payload: { sector: "Other" },
				column: "symbol",
				value: "OBSCURE",
			},
		]);
	});
});
