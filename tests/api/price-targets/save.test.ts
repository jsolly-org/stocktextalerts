import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiContext } from "../../helpers/api-context";

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
	getCurrentMarketSession: vi.fn().mockResolvedValue("regular"),
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

describe("A signed-in user saves or removes a price target for a watched symbol", () => {
	let handler: (ctx: ReturnType<typeof createApiContext>) => Promise<Response>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../../../src/pages/api/price-targets/save");
		handler = mod.POST as (ctx: ReturnType<typeof createApiContext>) => Promise<Response>;
	});

	it("A user saves an above target and receives direction in the response", async () => {
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
		const response = await handler(makeContext({ symbol: "AAPL", target_price: 200 }));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.direction).toBe("above");
	});

	it("A user saves a below target and receives direction in the response", async () => {
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
		const response = await handler(makeContext({ symbol: "AAPL", target_price: 200 }));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.direction).toBe("below");
	});

	it("A user removes a target by sending null target_price", async () => {
		setupMocks({});
		const response = await handler(makeContext({ symbol: "AAPL", target_price: null }));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.message).toBe("target_removed");
	});

	it("Symbol is normalized (trimmed and uppercased) before validation and save", async () => {
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
		const response = await handler(makeContext({ symbol: " aapl ", target_price: 200 }));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.direction).toBe("above");
	});
});
