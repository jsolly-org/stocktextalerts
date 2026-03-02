import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock modules before importing the handler
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
	return {
		request: new Request("http://localhost/api/price-targets/save", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		cookies: {} as never,
		locals: { requestId: "test-req" },
	} as never;
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
	upsertError?: unknown;
	deleteError?: unknown;
}) {
	const {
		user = { id: "user-1" },
		watchlist = [],
		prices = new Map(),
		upsertError = null,
		deleteError = null,
	} = options;
	const supabaseMock = {
		from: () => ({
			upsert: () => Promise.resolve({ error: upsertError }),
			delete: () => ({
				eq: () => ({
					eq: () => Promise.resolve({ error: deleteError }),
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

describe("POST /api/price-targets/save", () => {
	let handler: (ctx: never) => Promise<Response>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../../../src/pages/api/price-targets/save");
		handler = mod.POST as (ctx: never) => Promise<Response>;
	});

	it("returns 401 when unauthenticated", async () => {
		setupMocks({ user: null });
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(401);
	});

	it("returns 400 for missing symbol", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "", target_price: 200 }),
		);
		expect(response.status).toBe(400);
	});

	it("returns 400 for invalid target_price", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: -5 }),
		);
		expect(response.status).toBe(400);
	});

	it("returns 400 for zero target_price", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 0 }),
		);
		expect(response.status).toBe(400);
	});

	it("returns 400 when symbol not in watchlist", async () => {
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

	it("returns 400 when target equals current price", async () => {
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

	it("infers above direction when target > current", async () => {
		setupMocks({
			watchlist: [
				{
					symbol: "AAPL",
					name: "Apple",
					type: "stock",
					created_at: "2025-01-01",
				},
			],
			prices: new Map([["AAPL", { price: 195, changePercent: 1 }]]),
		});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.direction).toBe("above");
	});

	it("infers below direction when target < current", async () => {
		setupMocks({
			watchlist: [
				{
					symbol: "AAPL",
					name: "Apple",
					type: "stock",
					created_at: "2025-01-01",
				},
			],
			prices: new Map([["AAPL", { price: 205, changePercent: 1 }]]),
		});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: 200 }),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.direction).toBe("below");
	});

	it("deletes target when target_price is null", async () => {
		setupMocks({});
		const response = await handler(
			makeContext({ symbol: "AAPL", target_price: null }),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.message).toBe("target_removed");
	});
});
