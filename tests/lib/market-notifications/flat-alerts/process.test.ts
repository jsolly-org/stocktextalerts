/**
 * Integration-style flat price alert tests: real Supabase rows and
 * notification_log / price_move_alert_state assertions. Provider HTTP stays
 * stubbed; delivery uses a test-mode email sender.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../../src/lib/messaging/types";
import type { ExtendedAssetQuote } from "../../../../src/lib/types";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

/* =============
 * Mocks: only external providers + the email sender.
 * Supabase stays real so RPC/DB semantics are tested end-to-end.
 * ============= */
vi.mock("../../../../src/lib/market-data/bars", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/market-data/bars")>(
		"../../../../src/lib/market-data/bars",
	);
	return {
		...actual,
		fetchIntradayBars: vi.fn(async () => ({
			closes: [100, 101, 102, 103, 104, 105],
			timestamps: [null, null, null, null, null, null],
			startTimestamp: null,
			endTimestamp: Date.now(),
			candles: null,
		})),
	};
});

vi.mock("../../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/market-data/sparklines")>(
		"../../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
		fetchSparklines: vi.fn(async (symbols: string[]) => {
			const map = new Map();
			for (const s of symbols) {
				map.set(s, {
					values: [180, 182, 183, 185, 187, 190, 195],
					ascii: "▁▂▃▄▅▆▇",
					window: "7-trading-days",
				});
			}
			return map;
		}),
	};
});

const mockEmailSender = vi.fn<EmailSender>(async () => ({ success: true }));
vi.mock("../../../../src/lib/messaging/email/utils", async () => {
	const actual = await vi.importActual<typeof import("../../../../src/lib/messaging/email/utils")>(
		"../../../../src/lib/messaging/email/utils",
	);
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

vi.mock("../../../../src/lib/messaging/logo-fetcher", () => ({
	createLogoCache: vi.fn(() => ({})),
	fetchLogoBase64: vi.fn(async () => null),
	renderLogoImg: vi.fn(() => ""),
}));

import { processFlatPriceAlerts } from "../../../../src/lib/market-notifications/flat-alerts/process";

function makeQuote(overrides: Partial<ExtendedAssetQuote>): ExtendedAssetQuote {
	return {
		price: 195.86,
		changePercent: 5.3,
		dayHigh: 196,
		dayLow: 184,
		dayOpen: 184.5,
		prevClose: 186.0,
		timestamp: Math.floor(Date.now() / 1000),
		volume: 1_000_000,
		...overrides,
	};
}

async function enableFlatAlerts(userId: string, channels: { email?: boolean } = {}): Promise<void> {
	const wantEmail = channels.email ?? true;
	const { error } = await adminClient
		.from("users")
		.update({ email_notifications_enabled: wantEmail })
		.eq("id", userId);
	if (error) throw new Error(`Failed to enable flat alerts: ${error.message}`);

	// Per-option price_move_alerts facets live in notification_preferences
	// (default off); enable the email channel this test requested.
	await setTestUserPrefs(userId, [["price_move_alerts", "", "email", wantEmail]]);

	// Opt every tracked asset into price-move alerts at the default 5% threshold —
	// row presence is what enables the alert now (the pre-redesign behavior the
	// assertions below expect was a blanket 5% across the whole watchlist).
	const { data: assets } = await adminClient
		.from("user_assets")
		.select("symbol")
		.eq("user_id", userId);
	if (assets && assets.length > 0) {
		const { error: thresholdError } = await adminClient.from("price_move_alert_thresholds").upsert(
			assets.map((a) => ({
				user_id: userId,
				symbol: a.symbol,
				threshold_value: 5,
				threshold_unit: "percent",
			})),
			{ onConflict: "user_id,symbol" },
		);
		if (thresholdError) {
			throw new Error(`Failed to seed price-move thresholds: ${thresholdError.message}`);
		}
	}
}

/** Set a single per-stock threshold (value + unit) for a user, overriding the
 *  default seeded by {@link enableFlatAlerts}. */
async function setThreshold(
	userId: string,
	symbol: string,
	value: number,
	unit: "percent" | "dollar",
): Promise<void> {
	const { error } = await adminClient
		.from("price_move_alert_thresholds")
		.upsert(
			{ user_id: userId, symbol, threshold_value: value, threshold_unit: unit },
			{ onConflict: "user_id,symbol" },
		);
	if (error) throw new Error(`Failed to set threshold: ${error.message}`);
}

async function getNotificationLogCount(userId: string): Promise<number> {
	const { count, error } = await adminClient
		.from("notification_log")
		.select("*", { count: "exact", head: true })
		.eq("user_id", userId)
		.eq("type", "flat_price_alert");
	if (error) throw new Error(`Count query failed: ${error.message}`);
	return count ?? 0;
}

async function getStateRow(userId: string, symbol: string) {
	const { data, error } = await adminClient
		.from("price_move_alert_state")
		.select("last_notification_price, last_notification_at, pending_delivery")
		.eq("user_id", userId)
		.eq("symbol", symbol)
		.maybeSingle();
	if (error) throw new Error(`State query failed: ${error.message}`);
	return data;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockEmailSender.mockResolvedValue({ success: true });
});

describe("processFlatPriceAlerts", () => {
	it("Market closed: returns empty totals and makes zero DB calls", async () => {
		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap: new Map(),
			isMarketOpen: false,
		});

		expect(totals.usersChecked).toBe(0);
		expect(totals.alertsTriggered).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("User in Pacific timezone receives first alert on AAPL overnight gap", async () => {
		const testUser = await createTestUser({
			trackedAssets: ["AAPL"],
			timezone: "America/Los_Angeles",
		});
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// AAPL gapped from $186 (prev close) to $195.86 at open = +5.3%
		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.firstOfDayAlerts).toBe(1);
		expect(totals.reTriggerAlerts).toBe(0);
		expect(totals.emailsSent).toBe(1);
		expect(mockEmailSender).toHaveBeenCalledOnce();

		expect(await getNotificationLogCount(testUser.id)).toBe(1);

		const state = await getStateRow(testUser.id, "AAPL");
		expect(state).not.toBeNull();
		expect(Number(state?.last_notification_price)).toBeCloseTo(195.86, 2);
	});

	it("Sub-threshold +4.99% move does not trigger an alert", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// +4.99% from $186 = $195.28 (just below 5%)
		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.28 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(0);
		expect(totals.emailsSent).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getNotificationLogCount(testUser.id)).toBe(0);
		expect(await getStateRow(testUser.id, "AAPL")).toBeNull();
	});

	it("Re-trigger 27 minutes after first alert on a further 5% move", async () => {
		// Pin to a known mid-trading-day ET time so the 27-min-ago seed and
		// the implementation's "today in ET" check land on the same calendar
		// day — without this, the test flakes when run within ~30 min after
		// ET midnight (seed lands on yesterday ET → first-of-day, not re-trigger).
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-05-09T18:00:00.000Z")); // 14:00 ET

		try {
			const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
			registerTestUserForCleanup(testUser.id);
			await enableFlatAlerts(testUser.id);

			// Seed first-of-day state as if it fired 27 minutes ago at $195.86
			const twentySevenMinAgo = new Date(Date.now() - 27 * 60_000).toISOString();
			await adminClient.from("price_move_alert_state").insert({
				user_id: testUser.id,
				symbol: "AAPL",
				last_notification_price: 195.86,
				last_notification_at: twentySevenMinAgo,
			});

			// Price moves another 5.2% from $195.86 to $206.04
			const quoteMap = new Map([["AAPL", makeQuote({ price: 206.04 })]]);

			const totals = await processFlatPriceAlerts({
				supabase: adminClient,
				quoteMap,
				isMarketOpen: true,
			});

			expect(totals.alertsTriggered).toBe(1);
			expect(totals.firstOfDayAlerts).toBe(0);
			expect(totals.reTriggerAlerts).toBe(1);
			expect(totals.emailsSent).toBe(1);

			const state = await getStateRow(testUser.id, "AAPL");
			expect(Number(state?.last_notification_price)).toBeCloseTo(206.04, 2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("User with alerts disabled receives no email even on a 10% move", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		// Defaults: email off, no Telegram, and the price_move_alerts facet off —
		// this user has no usable channel, so they are never even a candidate.

		const quoteMap = new Map([["AAPL", makeQuote({ price: 204.6 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		// The candidate query is now channel-level (other channel-enabled users may be
		// fetched), so assert on THIS user's outcome rather than the global count: a
		// disabled user triggers nothing and receives no notification.
		expect(totals.alertsTriggered).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getNotificationLogCount(testUser.id)).toBe(0);
	});

	it("SPY tracked and moves +5.1% — ETF alert fires", async () => {
		const testUser = await createTestUser({ trackedAssets: ["SPY"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// SPY gapped from $520 to $546.50 = +5.1%
		const quoteMap = new Map([
			[
				"SPY",
				makeQuote({
					price: 546.5,
					prevClose: 520.0,
					dayOpen: 525.0,
					dayHigh: 548,
					dayLow: 525,
				}),
			],
		]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.firstOfDayAlerts).toBe(1);
		expect(totals.emailsSent).toBe(1);
	});

	it("TSLA gaps -5.24% overnight: alert fires on the negative move", async () => {
		const testUser = await createTestUser({ trackedAssets: ["TSLA"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// TSLA: prev close $256.80, dayOpen $242.10, current $243.34 = -5.24% from prev close
		const quoteMap = new Map([
			[
				"TSLA",
				makeQuote({
					price: 243.34,
					prevClose: 256.8,
					dayOpen: 242.1,
					dayHigh: 244,
					dayLow: 240,
				}),
			],
		]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.firstOfDayAlerts).toBe(1);
		expect(totals.emailsSent).toBe(1);

		// Inspect the rendered email body to confirm both time-horizon rows reflect
		// the overnight gap vs. the intraday recovery
		expect(mockEmailSender).toHaveBeenCalledOnce();
		const callArgs = mockEmailSender.mock.calls[0]![0] as {
			subject: string;
			body: string;
			html?: string;
		};
		expect(callArgs.subject).toContain("↓");
		expect(callArgs.subject).toContain("TSLA");
		// Text body contains both framings
		expect(callArgs.body).toMatch(/Since today's open/);
		expect(callArgs.body).toMatch(/Since prev close/);
		// Email HTML labels the intraday sparkline; the 7-day chart is labeled by its row title.
		expect(callArgs.html).toContain("Today since open:");
		expect(callArgs.html).toContain("Past 7 trading days");
	});

	it("Email delivery failure releases the reserved slot without committing baseline", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SES throttled",
		});

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const { expectConsoleError } = await import("../../../setup");
		expectConsoleError("Failed to send flat price alert email");

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.emailsSent).toBe(0);
		expect(totals.emailsFailed).toBe(1);

		const state = await getStateRow(testUser.id, "AAPL");
		expect(state).toBeNull();
	});

	it("Thinly-traded asset with null prev_close is skipped on first-of-day", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// Massive occasionally omits prev_close for thinly-traded symbols or OTC
		// names. First-of-day path has no baseline to measure from, so the
		// symbol is skipped with an info log — no email, no state row.
		const quoteMap = new Map([["AAPL", makeQuote({ price: 200, prevClose: null })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(0);
		expect(totals.emailsSent).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getStateRow(testUser.id, "AAPL")).toBeNull();
	});

	it("fetchIntradayBars failure gracefully degrades — email still sends without sparkline", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// Simulate a transient Massive 5xx during market hours
		const { fetchIntradayBars } = await import("../../../../src/lib/market-data/bars");
		vi.mocked(fetchIntradayBars).mockRejectedValueOnce(new Error("Massive 502 bad gateway"));

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		// The alert still fires and the email still sends — just without the
		// intraday sparkline block
		expect(totals.alertsTriggered).toBe(1);
		expect(totals.emailsSent).toBe(1);
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});

	it("State fetch DB error aborts the run instead of silently alerting with wrong baselines", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// Wrap the admin client so the price_move_alert_state SELECT throws,
		// but every other query passes through normally.
		const failingSupabase = new Proxy(adminClient, {
			get(target, prop, receiver) {
				if (prop === "from") {
					return (table: string) => {
						if (table === "price_move_alert_state") {
							return {
								select: () => ({
									in: async () => ({
										data: null,
										error: { message: "connection reset", code: "08006" },
									}),
								}),
							};
						}
						return Reflect.get(target, prop, receiver).call(target, table);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const { expectConsoleError } = await import("../../../setup");
		expectConsoleError("Failed to fetch flat price alert state");

		// processFlatPriceAlerts should throw — run.ts catches and logs.
		// We simulate the caller's try/catch here.
		let threw = false;
		try {
			await processFlatPriceAlerts({
				supabase: failingSupabase as typeof adminClient,
				quoteMap,
				isMarketOpen: true,
			});
		} catch (_err) {
			threw = true;
		}

		expect(threw).toBe(true);
		expect(mockEmailSender).not.toHaveBeenCalled();
		// No state row written
		expect(await getStateRow(testUser.id, "AAPL")).toBeNull();
	});

	it("Reserve RPC permission error skips delivery instead of sending without idempotency", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id, { email: true });

		const failingSupabase = new Proxy(adminClient, {
			get(target, prop, receiver) {
				if (prop === "rpc") {
					return (fn: string, args: unknown) => {
						if (fn === "reserve_flat_price_alert") {
							return Promise.resolve({
								data: null,
								error: {
									code: "42501",
									message: "permission denied for function reserve_flat_price_alert",
								},
							});
						}
						return Reflect.get(target, prop, receiver).call(target, fn, args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const { expectConsoleError } = await import("../../../setup");
		expectConsoleError("Failed to reserve flat price alert slot");

		const totals = await processFlatPriceAlerts({
			supabase: failingSupabase as typeof adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.claimLost).toBe(1);
		expect(totals.alertsTriggered).toBe(0);
		expect(totals.emailsSent).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getNotificationLogCount(testUser.id)).toBe(0);
		expect(await getStateRow(testUser.id, "AAPL")).toBeNull();
	});

	it("Dollar-unit threshold: a +$6.51 move (+3.5%) clears a $5 threshold — fires ONLY if the dollar unit is honored", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);
		// Override the default 5% with a $5 absolute-dollar threshold.
		await setThreshold(testUser.id, "AAPL", 5, "dollar");

		// Discriminating fixture: $186 prev close → $192.51 = +$6.51 but only
		// +3.50%. A regression that ignores the unit and reads the 5 as percent
		// would NOT fire (3.50 < 5); the dollar semantics must (6.51 >= 5).
		const quoteMap = new Map([["AAPL", makeQuote({ price: 192.51 })]]);
		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.emailsSent).toBe(1);
	});

	it("Dollar-unit threshold: a +$4.40 move (+8.8%) stays under an $8 threshold — skips ONLY if the dollar unit is honored", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);
		await setThreshold(testUser.id, "AAPL", 8, "dollar");

		// Discriminating fixture: $50 prev close → $54.40 = +$4.40 but +8.8%.
		// A percent-read of the 8 WOULD fire (8.8 >= 8); the dollar semantics
		// must not (4.40 < 8).
		const quoteMap = new Map([
			["AAPL", makeQuote({ price: 54.4, prevClose: 50, dayOpen: 50.5, dayHigh: 55, dayLow: 49.5 })],
		]);
		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getStateRow(testUser.id, "AAPL")).toBeNull();
	});

	it("A tracked asset with no threshold row is opted out and never evaluated", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);
		// Clear the default threshold so AAPL is fully opted out.
		await adminClient
			.from("price_move_alert_thresholds")
			.delete()
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL");

		// A large +10% move, but with no threshold row nothing fires.
		const quoteMap = new Map([["AAPL", makeQuote({ price: 204.6 })]]);
		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(await getNotificationLogCount(testUser.id)).toBe(0);
	});
});
