import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedAssetQuote } from "../../../src/lib/providers/price-fetcher";

// Mock external dependencies
vi.mock("../../../src/lib/providers/price-fetcher", () => ({
	getCurrentMarketSession: vi.fn(),
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
	deliverPriceTargetAlert: vi.fn(async () => true),
}));

import { deliverPriceTargetAlert } from "../../../src/lib/price-targets/delivery";
import { processPriceTargets } from "../../../src/lib/price-targets/process";
import { getCurrentMarketSession } from "../../../src/lib/providers/price-fetcher";

const mockGetCurrentMarketSession = vi.mocked(getCurrentMarketSession);
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
		triggered_at?: string | null;
		triggered_price?: number | null;
	}>;
	users?: Array<{
		id: string;
		email: string;
		phone_country_code: string | null;
		phone_number: string | null;
		phone_verified: boolean;
		sms_notifications_enabled: boolean;
		sms_opted_out: boolean;
		price_targets_include_email: boolean;
		price_targets_include_sms: boolean;
	}>;
	onDelete?: () => void;
	onUpdate?: () => void;
	/** Rows returned by the CAS claim's .select(). Empty = another run won the claim. */
	claimedRows?: Array<{ user_id: string }>;
}) {
	const {
		targets = [],
		users = [],
		onDelete,
		onUpdate,
		claimedRows = [{ user_id: "user-1" }],
	} = options;
	return {
		from: (table: string) => {
			if (table === "price_targets") {
				return {
					select: () => Promise.resolve({ data: targets, error: null }),
					update: () => ({
						eq: () => ({
							eq: () => ({
								eq: () => ({
									eq: () => ({
										is: () => ({
											select: () => {
												onUpdate?.();
												return Promise.resolve({ data: claimedRows, error: null });
											},
										}),
									}),
								}),
							}),
						}),
					}),
					delete: () => ({
						eq: () => ({
							eq: () => ({
								eq: () => ({
									eq: () => {
										onDelete?.();
										return Promise.resolve({ error: null });
									},
								}),
							}),
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
			if (table === "assets") {
				return {
					select: () => ({
						in: () => Promise.resolve({ data: [], error: null }),
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
	price_targets_include_email: true,
	price_targets_include_sms: false,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Price target processing", () => {
	it("No targets are checked when the market is closed", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("closed");

		const totals = await processPriceTargets({
			supabase: makeSupabaseMock({ targets: [] }),
		});

		expect(totals.targetsChecked).toBe(0);
		expect(totals.targetsTriggered).toBe(0);
	});

	it("A user receives an alert when price reaches their above target", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

		const quoteMap = new Map([["AAPL", makeQuote(205)]]);
		let deleted = false;
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
			onDelete: () => {
				deleted = true;
			},
		});

		const totals = await processPriceTargets({
			supabase,
			quoteMap,
		});

		expect(totals.targetsChecked).toBe(1);
		expect(totals.targetsTriggered).toBe(1);
		expect(mockDeliverPriceTargetAlert).toHaveBeenCalledOnce();
		// After a successful delivery the target is removed so it can't re-alert.
		expect(deleted).toBe(true);
	});

	it("A second overlapping scheduler run that loses the triggered_at claim does not deliver a duplicate alert", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

		const quoteMap = new Map([["AAPL", makeQuote(205)]]);
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 200,
					direction: "above",
					triggered_at: null,
					triggered_price: null,
				},
			],
			users: [testUser],
			// The CAS UPDATE ... WHERE triggered_at IS NULL matched zero rows:
			// another invocation already claimed this target this tick.
			claimedRows: [],
		});

		const totals = await processPriceTargets({ supabase, quoteMap });

		expect(totals.targetsChecked).toBe(1);
		// Lost the CAS: not delivered AND not counted as triggered, so the
		// targetsTriggered metric isn't inflated by the duplicate scheduler run.
		expect(totals.targetsTriggered).toBe(0);
		expect(mockDeliverPriceTargetAlert).not.toHaveBeenCalled();
	});

	it("A user receives an alert when price reaches their below target", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

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

	it("No alert is sent when price has not reached the target", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

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

	it("An alert is sent when price exactly equals the above target", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

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

	it("keeps a triggered target when delivery fails so it can retry", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");
		mockDeliverPriceTargetAlert.mockResolvedValueOnce(false);

		let deleted = false;
		let markedPending = false;
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 150,
					direction: "above",
					triggered_at: null,
					triggered_price: null,
				},
			],
			users: [
				{
					id: "user-1",
					email: "a@b.com",
					phone_country_code: null,
					phone_number: null,
					phone_verified: false,
					sms_notifications_enabled: false,
					sms_opted_out: false,
					price_targets_include_email: true,
					price_targets_include_sms: false,
				},
			],
			onDelete: () => {
				deleted = true;
			},
			onUpdate: () => {
				markedPending = true;
			},
		});

		const quoteMap = new Map<string, ExtendedAssetQuote>([["AAPL", makeQuote(160)]]);

		const totals = await processPriceTargets({ supabase, quoteMap });

		expect(totals.targetsTriggered).toBe(1);
		expect(markedPending).toBe(true);
		expect(deleted).toBe(false);
	});

	it("No targets are checked when none exist", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

		const supabase = makeSupabaseMock({ targets: [], users: [] });

		const totals = await processPriceTargets({ supabase });

		expect(totals.targetsChecked).toBe(0);
		expect(totals.targetsTriggered).toBe(0);
	});
});
