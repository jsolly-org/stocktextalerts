import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedAssetQuote } from "../../../src/lib/providers/price-fetcher";

// Mock external dependencies
vi.mock("../../../src/lib/providers/price-fetcher", () => ({
	fetchMarketStatus: vi.fn(),
	fetchExtendedQuotes: vi.fn(),
}));

vi.mock("../../../src/lib/messaging/email/utils", () => ({
	createEmailSender: () => vi.fn(async () => ({ success: true })),
}));

vi.mock("../../../src/lib/schedule/sms-sender", () => ({
	createSmsSenderProvider: () => () => ({
		sender: vi.fn(async () => ({ success: true })),
	}),
}));

vi.mock("../../../src/lib/price-targets/delivery", () => ({
	deliverPriceTargetAlert: vi.fn(async () => {}),
}));

import { deliverPriceTargetAlert } from "../../../src/lib/price-targets/delivery";
import { processPriceTargets } from "../../../src/lib/price-targets/process";
import { fetchMarketStatus } from "../../../src/lib/providers/price-fetcher";

const mockFetchMarketStatus = vi.mocked(fetchMarketStatus);
const mockDeliverPriceTargetAlert = vi.mocked(deliverPriceTargetAlert);

function makeQuote(price: number): ExtendedAssetQuote {
	return {
		price,
		changePercent: 0,
		dayHigh: price + 1,
		dayLow: price - 1,
		dayOpen: price - 0.5,
		prevClose: price - 1,
		timestamp: Date.now(),
		volume: 1_000_000,
	};
}

function makeSupabaseMock(options: {
	targets?: Array<{
		user_id: string;
		symbol: string;
		target_price: number;
		direction: string;
	}>;
	users?: Array<{
		id: string;
		email: string;
		phone_country_code: string | null;
		phone_number: string | null;
		phone_verified: boolean;
		sms_notifications_enabled: boolean;
		sms_opted_out: boolean;
		market_asset_price_alerts_include_email: boolean;
		market_asset_price_alerts_include_sms: boolean;
	}>;
}) {
	const { targets = [], users = [] } = options;
	return {
		from: (table: string) => {
			if (table === "price_targets") {
				return {
					select: () => Promise.resolve({ data: targets, error: null }),
					delete: () => ({
						eq: () => ({
							eq: () => Promise.resolve({ error: null }),
						}),
					}),
				};
			}
			if (table === "users") {
				return {
					select: () => ({
						in: () =>
							Promise.resolve({
								data: users,
								error: null,
							}),
					}),
				};
			}
			// notification_log
			return {
				insert: async () => ({ error: null }),
			};
		},
	} as never;
}

const testUser = {
	id: "user-1",
	email: "test@example.com",
	phone_country_code: "+1",
	phone_number: "5551112222",
	phone_verified: true,
	sms_notifications_enabled: true,
	sms_opted_out: false,
	market_asset_price_alerts_include_email: true,
	market_asset_price_alerts_include_sms: false,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("processPriceTargets", () => {
	it("skips when market is closed", async () => {
		mockFetchMarketStatus.mockResolvedValue(false);

		const totals = await processPriceTargets({
			supabase: makeSupabaseMock({ targets: [] }),
		});

		expect(totals.targetsChecked).toBe(0);
		expect(totals.targetsTriggered).toBe(0);
	});

	it("triggers target when price meets above direction", async () => {
		mockFetchMarketStatus.mockResolvedValue(true);

		const quoteMap = new Map([["AAPL", makeQuote(205)]]);
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 200,
					direction: "above",
				},
			],
			users: [testUser],
		});

		const totals = await processPriceTargets({
			supabase,
			quoteMap,
		});

		expect(totals.targetsChecked).toBe(1);
		expect(totals.targetsTriggered).toBe(1);
		expect(mockDeliverPriceTargetAlert).toHaveBeenCalledOnce();
	});

	it("triggers target when price meets below direction", async () => {
		mockFetchMarketStatus.mockResolvedValue(true);

		const quoteMap = new Map([["TSLA", makeQuote(145)]]);
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "TSLA",
					target_price: 150,
					direction: "below",
				},
			],
			users: [testUser],
		});

		const totals = await processPriceTargets({
			supabase,
			quoteMap,
		});

		expect(totals.targetsChecked).toBe(1);
		expect(totals.targetsTriggered).toBe(1);
	});

	it("does not trigger when price has not reached target", async () => {
		mockFetchMarketStatus.mockResolvedValue(true);

		const quoteMap = new Map([["AAPL", makeQuote(195)]]);
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 200,
					direction: "above",
				},
			],
			users: [testUser],
		});

		const totals = await processPriceTargets({
			supabase,
			quoteMap,
		});

		expect(totals.targetsChecked).toBe(1);
		expect(totals.targetsTriggered).toBe(0);
		expect(mockDeliverPriceTargetAlert).not.toHaveBeenCalled();
	});

	it("triggers at exact boundary (above: current == target)", async () => {
		mockFetchMarketStatus.mockResolvedValue(true);

		const quoteMap = new Map([["AAPL", makeQuote(200)]]);
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 200,
					direction: "above",
				},
			],
			users: [testUser],
		});

		const totals = await processPriceTargets({
			supabase,
			quoteMap,
		});

		expect(totals.targetsTriggered).toBe(1);
	});

	it("returns empty when no targets exist", async () => {
		mockFetchMarketStatus.mockResolvedValue(true);

		const supabase = makeSupabaseMock({ targets: [], users: [] });

		const totals = await processPriceTargets({ supabase });

		expect(totals.targetsChecked).toBe(0);
		expect(totals.targetsTriggered).toBe(0);
	});
});
