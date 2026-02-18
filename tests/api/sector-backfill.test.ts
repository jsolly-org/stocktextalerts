import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as runSectorBackfill } from "../../../src/pages/api/sector-backfill";
import { createApiContext } from "../../helpers/api-context";
import { createCronRequest } from "../../helpers/cron";

type QueryRow = { symbol: string };
type UpdateCall = {
	payload: Record<string, unknown>;
	column: string;
	value: unknown;
};

const state: {
	queryRows: QueryRow[];
	updateCalls: UpdateCall[];
} = {
	queryRows: [],
	updateCalls: [],
};

const { createSupabaseAdminClientMock, marketDataFetchMock } = vi.hoisted(
	() => ({
		createSupabaseAdminClientMock: vi.fn(),
		marketDataFetchMock: vi.fn(),
	}),
);

vi.mock("../../../src/lib/db/supabase", () => ({
	createSupabaseAdminClient: createSupabaseAdminClientMock,
}));

vi.mock("../../../src/lib/providers/massive", () => ({
	marketDataFetch: marketDataFetchMock,
}));

describe("A cron worker backfills missing asset sectors.", () => {
	const testCronSecret = "sector-backfill-test-secret";

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", testCronSecret);
		state.queryRows = [];
		state.updateCalls = [];
		marketDataFetchMock.mockReset();

		const mockSupabase = {
			from: (table: string) => {
				if (table !== "assets") {
					throw new Error(`Unexpected table in test mock: ${table}`);
				}

				return {
					select: () => ({
						is: () => ({
							limit: async () => ({ data: state.queryRows, error: null }),
						}),
					}),
					update: (payload: Record<string, unknown>) => ({
						eq: async (column: string, value: unknown) => {
							state.updateCalls.push({ payload, column, value });
							return { error: null };
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
});
