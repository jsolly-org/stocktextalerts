import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrefChannel } from "../../../src/lib/messaging/notification-prefs";
import type { ExtendedAssetQuote } from "../../../src/lib/types";

// Mock external dependencies
vi.mock("../../../src/lib/market-data/session", () => ({
	getCurrentMarketSession: vi.fn(),
}));
vi.mock("../../../src/lib/market-data/prices", () => ({
	fetchExtendedQuotes: vi.fn(),
}));

vi.mock("../../../src/lib/messaging/email/utils", () => ({
	createEmailSender: () => vi.fn(async () => ({ success: true })),
}));

vi.mock("../../../src/lib/messaging/sms/sender-factory", () => ({
	createSmsSenderFactory: () => () => ({
		sender: vi.fn(async () => ({ success: true })),
	}),
}));

vi.mock("../../../src/lib/price-targets/delivery", () => ({
	deliverPriceTargetAlert: vi.fn(async () => ({
		email: "sent",
		sms: "skipped",
		telegram: "skipped",
	})),
}));

import { getCurrentMarketSession } from "../../../src/lib/market-data/session";
import { deliverPriceTargetAlert } from "../../../src/lib/price-targets/delivery";
import { processPriceTargets } from "../../../src/lib/price-targets/process";

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
		attempt_count?: number;
		next_retry_at?: string | null;
		email_delivered_at?: string | null;
		sms_delivered_at?: string | null;
		telegram_delivered_at?: string | null;
	}>;
	users?: Array<{
		id: string;
		email: string;
		email_notifications_enabled: boolean;
		phone_country_code: string | null;
		phone_number: string | null;
		phone_verified: boolean;
		sms_notifications_enabled: boolean;
		sms_opted_out: boolean;
		telegram_chat_id: number | null;
		telegram_opted_out: boolean;
	}>;
	/**
	 * notification_preferences rows returned by attachPrefsToUsers' batch IN query.
	 * Per-option facets are the single source of truth — defaults to the
	 * price_targets email facet enabled so triggered targets deliver.
	 */
	prefs?: Array<{
		user_id: string;
		notification_type: string;
		content: string;
		channel: PrefChannel;
		enabled: boolean;
	}>;
	onDelete?: () => void;
	/** Fires when the CAS claim UPDATE (`triggered_at` set) runs. */
	onUpdate?: () => void;
	/** Captures the payload of the retry-state UPDATE (attempt_count / next_retry_at /
	 *  *_delivered_at) — i.e. any UPDATE that is NOT the claim. */
	onRetryUpdate?: (payload: Record<string, unknown>) => void;
	/** Rows returned by the CAS claim's .select(). Empty = another run won the claim. */
	claimedRows?: Array<{ user_id: string }>;
}) {
	const {
		targets = [],
		users = [],
		prefs = [
			{
				user_id: "user-1",
				notification_type: "price_targets",
				content: "",
				channel: "email",
				enabled: true,
			},
		],
		onDelete,
		onUpdate,
		onRetryUpdate,
		claimedRows = [{ user_id: "user-1" }],
	} = options;
	return {
		from: (table: string) => {
			if (table === "price_targets") {
				return {
					select: () =>
						Promise.resolve({
							// Default the delivery-retry columns (NOT NULL DEFAULT 0 / NULL in prod)
							// so the loop reads real numbers, mirroring the live schema.
							data: targets.map((t) => ({
								triggered_at: null,
								triggered_price: null,
								attempt_count: 0,
								next_retry_at: null,
								email_delivered_at: null,
								sms_delivered_at: null,
								telegram_delivered_at: null,
								...t,
							})),
							error: null,
						}),
					update: (payload: Record<string, unknown>) => {
						// The CAS claim sets triggered_at (then .is().select()); the retry-state
						// update sets attempt_count/next_retry_at/*_delivered_at (awaited after 4 eqs).
						if (payload && "triggered_at" in payload) {
							return {
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
							};
						}
						onRetryUpdate?.(payload);
						return {
							eq: () => ({
								eq: () => ({
									eq: () => ({
										eq: () => Promise.resolve({ error: null }),
									}),
								}),
							}),
						};
					},
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
			if (table === "notification_preferences") {
				return {
					select: () => ({
						in: () => Promise.resolve({ data: prefs, error: null }),
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
	email_notifications_enabled: true,
	phone_country_code: "+1",
	phone_number: "5551112222",
	phone_verified: true,
	sms_notifications_enabled: true,
	sms_opted_out: false,
	telegram_chat_id: null,
	telegram_opted_out: false,
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
		mockDeliverPriceTargetAlert.mockResolvedValueOnce({
			email: "failed",
			sms: "skipped",
			telegram: "skipped",
		});

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
					email_notifications_enabled: true,
					phone_country_code: null,
					phone_number: null,
					phone_verified: false,
					sms_notifications_enabled: false,
					sms_opted_out: false,
					telegram_chat_id: null,
					telegram_opted_out: false,
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

	it("A partial delivery keeps the target, records the delivered channel, and schedules a retry", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");
		// Email lands, Telegram transiently fails.
		mockDeliverPriceTargetAlert.mockResolvedValueOnce({
			email: "sent",
			sms: "skipped",
			telegram: "failed",
		});

		let deleted = false;
		let retryPayload: Record<string, unknown> | null = null;
		const supabase = makeSupabaseMock({
			// Already-triggered (pending) target, mid-retry.
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 150,
					direction: "above",
					triggered_at: "2026-06-24T17:00:00.000Z",
					triggered_price: 151,
					attempt_count: 0,
				},
			],
			users: [{ ...testUser, telegram_chat_id: 9001 }],
			prefs: [
				{
					user_id: "user-1",
					notification_type: "price_targets",
					content: "",
					channel: "email",
					enabled: true,
				},
				{
					user_id: "user-1",
					notification_type: "price_targets",
					content: "",
					channel: "telegram",
					enabled: true,
				},
			],
			onDelete: () => {
				deleted = true;
			},
			onRetryUpdate: (payload) => {
				retryPayload = payload;
			},
		});

		await processPriceTargets({ supabase });

		// Telegram still owes delivery, so the target is NOT cleared.
		expect(deleted).toBe(false);
		expect(retryPayload).not.toBeNull();
		const payload = retryPayload as unknown as Record<string, unknown>;
		expect(payload.attempt_count).toBe(1);
		expect(payload.next_retry_at).toBeTruthy();
		// The delivered channel is recorded so it is not re-sent next round...
		expect(payload.email_delivered_at).toBeTruthy();
		// ...but the failed channel is not.
		expect(payload.telegram_delivered_at).toBeUndefined();
	});

	it("Already-delivered channels are skipped on the next retry round", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");
		mockDeliverPriceTargetAlert.mockResolvedValueOnce({
			email: "skipped",
			sms: "skipped",
			telegram: "sent",
		});

		let deleted = false;
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 150,
					direction: "above",
					triggered_at: "2026-06-24T17:00:00.000Z",
					triggered_price: 151,
					attempt_count: 1,
					email_delivered_at: "2026-06-24T17:00:30.000Z",
				},
			],
			users: [{ ...testUser, telegram_chat_id: 9001 }],
			prefs: [
				{
					user_id: "user-1",
					notification_type: "price_targets",
					content: "",
					channel: "email",
					enabled: true,
				},
				{
					user_id: "user-1",
					notification_type: "price_targets",
					content: "",
					channel: "telegram",
					enabled: true,
				},
			],
			onDelete: () => {
				deleted = true;
			},
		});

		await processPriceTargets({ supabase });

		// The processor tells the delivery layer email is already done, so it isn't re-sent.
		const callArgs = mockDeliverPriceTargetAlert.mock.calls[0]?.[0] as
			| { alreadyDelivered?: { email: boolean; sms: boolean; telegram: boolean } }
			| undefined;
		expect(callArgs?.alreadyDelivered).toEqual({ email: true, sms: false, telegram: false });
		// Telegram landed this round → every required channel done → target cleared.
		expect(deleted).toBe(true);
	});

	it("An undeliverable target is cleared once the retry ceiling is reached", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");
		mockDeliverPriceTargetAlert.mockResolvedValueOnce({
			email: "failed",
			sms: "skipped",
			telegram: "skipped",
		});
		// Terminal-failure path logs at error; absorb + assert it fires for the alarm.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let deleted = false;
		let retried = false;
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 150,
					direction: "above",
					triggered_at: "2026-06-24T17:00:00.000Z",
					triggered_price: 151,
					// One short of the ceiling → this round (attempt 3) exhausts it.
					attempt_count: 2,
				},
			],
			users: [testUser],
			onDelete: () => {
				deleted = true;
			},
			onRetryUpdate: () => {
				retried = true;
			},
		});

		await processPriceTargets({ supabase });

		expect(deleted).toBe(true);
		expect(retried).toBe(false);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("A pending target whose backoff window has not elapsed waits — no delivery, no clear, no re-update", async () => {
		// This is the throttle the retry ceiling depends on: without it, a failing target
		// re-fires every market-minute. next_retry_at far in the future = window not elapsed.
		mockGetCurrentMarketSession.mockResolvedValue("regular");

		let deleted = false;
		let retried = false;
		const supabase = makeSupabaseMock({
			targets: [
				{
					user_id: "user-1",
					symbol: "AAPL",
					target_price: 150,
					direction: "above",
					triggered_at: "2026-06-24T17:00:00.000Z",
					triggered_price: 151,
					attempt_count: 1,
					next_retry_at: "2099-01-01T00:00:00.000Z",
				},
			],
			users: [testUser],
			onDelete: () => {
				deleted = true;
			},
			onRetryUpdate: () => {
				retried = true;
			},
		});

		await processPriceTargets({ supabase });

		expect(mockDeliverPriceTargetAlert).not.toHaveBeenCalled();
		expect(deleted).toBe(false);
		expect(retried).toBe(false);
	});

	it("No targets are checked when none exist", async () => {
		mockGetCurrentMarketSession.mockResolvedValue("regular");

		const supabase = makeSupabaseMock({ targets: [], users: [] });

		const totals = await processPriceTargets({ supabase });

		expect(totals.targetsChecked).toBe(0);
		expect(totals.targetsTriggered).toBe(0);
	});
});
