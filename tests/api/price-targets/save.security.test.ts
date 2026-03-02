import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiContext } from "../../helpers/api-context";

vi.mock("../../../src/lib/db/supabase", () => ({
	createSupabaseServerClient: vi.fn(),
}));

vi.mock("../../../src/lib/db", () => ({
	createUserService: vi.fn(),
	getUserAssets: vi.fn(),
}));

vi.mock("../../../src/lib/providers/price-fetcher", () => ({
	fetchAssetPrices: vi.fn(),
}));

import { createUserService, getUserAssets } from "../../../src/lib/db";
import { createSupabaseServerClient } from "../../../src/lib/db/supabase";
import { fetchAssetPrices } from "../../../src/lib/providers/price-fetcher";

const mockCreateSupabaseServerClient = vi.mocked(createSupabaseServerClient);
const mockCreateUserService = vi.mocked(createUserService);
const mockGetUserAssets = vi.mocked(getUserAssets);
const mockFetchAssetPrices = vi.mocked(fetchAssetPrices);

function makeContext(body: unknown) {
	return createApiContext({
		request: new Request("http://localhost/api/price-targets/save", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	});
}

function setupMocks(options: {
	user?: { id: string } | null;
	watchlist?: Array<{
		symbol: string;
		name: string;
		type: string;
		created_at: string;
	}>;
	prices?: Map<string, { price: number; changePercent: number } | null>;
}) {
	const {
		user = { id: "user-1" },
		watchlist = [],
		prices = new Map(),
	} = options;
	const supabaseMock = {
		from: () => ({
			upsert: () => Promise.resolve({ error: null }),
			delete: () => ({
				eq: () => ({
					eq: () => Promise.resolve({ error: null }),
				}),
			}),
		}),
	};
	mockCreateSupabaseServerClient.mockReturnValue(supabaseMock as never);
	mockCreateUserService.mockReturnValue({
		getCurrentUser: async () => user,
	} as never);
	mockGetUserAssets.mockResolvedValue(watchlist as never);
	mockFetchAssetPrices.mockResolvedValue(prices);
}

describe("Price target save API rejects unauthorized or invalid requests", () => {
	let handler: (ctx: ReturnType<typeof createApiContext>) => Promise<Response>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../../../src/pages/api/price-targets/save");
		handler = mod.POST as (
			ctx: ReturnType<typeof createApiContext>,
		) => Promise<Response>;
	});

	it("An unauthenticated user receives 401", async () => {
		setupMocks({ user: null });
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(401);
	});

	it("A request with missing symbol receives 400", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "", target_price: 200 }),
		);
		expect(response.status).toBe(400);
	});

	it("A request with invalid target_price receives 400", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: -5 }),
		);
		expect(response.status).toBe(400);
	});

	it("A request with zero target_price receives 400", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 0 }),
		);
		expect(response.status).toBe(400);
	});

	it("A user cannot set a target for a symbol not on their watchlist", async () => {
		setupMocks({
			watchlist: [
				{
					symbol: "GOOG",
					name: "Alphabet",
					type: "stock",
					created_at: "2025-01-01",
				},
			],
			prices: new Map([["AAPL", { price: 195, changePercent: 1 }]]),
		});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.message).toBe("symbol_not_in_watchlist");
	});

	it("A user cannot set a target equal to current price", async () => {
		setupMocks({
			watchlist: [
				{
					symbol: "AAPL",
					name: "Apple",
					type: "stock",
					created_at: "2025-01-01",
				},
			],
			prices: new Map([["AAPL", { price: 200, changePercent: 1 }]]),
		});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.message).toBe("target_equals_current");
	});
});
