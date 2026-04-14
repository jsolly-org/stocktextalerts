import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedAssetQuote } from "../../../../src/lib/providers/price-fetcher";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

/* =============
 * Mocks: only external providers + the email sender.
 * Supabase stays real so RPC/DB semantics are tested end-to-end.
 * ============= */
vi.mock("../../../../src/lib/providers/massive", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../src/lib/providers/massive")
	>("../../../../src/lib/providers/massive");
	return {
		...actual,
		fetchIntradayBars: vi.fn(async () => ({
			closes: [100, 101, 102, 103, 104, 105],
			timestamps: [null, null, null, null, null, null],
			startTimestamp: null,
			endTimestamp: Date.now(),
		})),
	};
});

vi.mock("../../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../src/lib/providers/price-fetcher")
	>("../../../../src/lib/providers/price-fetcher");
	return {
		...actual,
		fetchSparklines: vi.fn(async (symbols: string[]) => {
			const map = new Map();
			for (const s of symbols) {
				map.set(s, {
					values: [180, 182, 183, 185, 187, 190, 195],
					ascii: "▁▂▃▄▅▆▇",
				});
			}
			return map;
		}),
	};
});

const mockEmailSender = vi.fn(async () => ({ success: true }));
vi.mock("../../../../src/lib/messaging/email/utils", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../src/lib/messaging/email/utils")
	>("../../../../src/lib/messaging/email/utils");
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

const mockSmsSender = vi.fn(async () => ({ success: true }));
vi.mock("../../../../src/lib/schedule/sms-sender", () => ({
	createSmsSenderProvider: () => () => ({ sender: mockSmsSender }),
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

async function enableFlatAlerts(
	userId: string,
	channels: { email?: boolean; sms?: boolean } = {},
): Promise<void> {
	const wantEmail = channels.email ?? true;
	const wantSms = channels.sms ?? false;
	const updates: Record<string, unknown> = {
		price_move_alerts_include_email: wantEmail,
		price_move_alerts_include_sms: wantSms,
		email_notifications_enabled: wantEmail,
	};
	if (wantSms) {
		updates.sms_notifications_enabled = true;
		updates.phone_verified = true;
		updates.phone_country_code = "+1";
		updates.phone_number = "5555550123";
		updates.sms_opted_out = false;
	}
	const { error } = await adminClient
		.from("users")
		.update(updates)
		.eq("id", userId);
	if (error) throw new Error(`Failed to enable flat alerts: ${error.message}`);
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
		.select("last_notification_price, last_notification_at")
		.eq("user_id", userId)
		.eq("symbol", symbol)
		.maybeSingle();
	if (error) throw new Error(`State query failed: ${error.message}`);
	return data;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockEmailSender.mockResolvedValue({ success: true });
	mockSmsSender.mockResolvedValue({ success: true });
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
	});

	it("User with alerts disabled receives no email even on a 10% move", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		// Explicitly keep both channel flags false (the default)

		const quoteMap = new Map([["AAPL", makeQuote({ price: 204.6 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.usersChecked).toBe(0);
		expect(totals.alertsTriggered).toBe(0);
		expect(mockEmailSender).not.toHaveBeenCalled();
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
		const callArgs = mockEmailSender.mock.calls[0]?.[0] as {
			subject: string;
			body: string;
		};
		expect(callArgs.subject).toContain("↓");
		expect(callArgs.subject).toContain("TSLA");
		// Text body contains both framings
		expect(callArgs.body).toMatch(/Since today's open/);
		expect(callArgs.body).toMatch(/Since prev close/);
	});

	it("Email delivery failure still upserts state row (via atomic claim)", async () => {
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

		// State row was upserted by the claim RPC before delivery
		const state = await getStateRow(testUser.id, "AAPL");
		expect(state).not.toBeNull();
		expect(Number(state?.last_notification_price)).toBeCloseTo(195.86, 2);
	});

	it("Thinly-traded asset with null prev_close is skipped on first-of-day", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id);

		// Massive occasionally omits prev_close for thinly-traded symbols or OTC
		// names. First-of-day path has no baseline to measure from, so the
		// symbol is skipped with an info log — no email, no state row.
		const quoteMap = new Map([
			["AAPL", makeQuote({ price: 200, prevClose: null })],
		]);

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
		const { fetchIntradayBars } = await import(
			"../../../../src/lib/providers/massive"
		);
		vi.mocked(fetchIntradayBars).mockRejectedValueOnce(
			new Error("Massive 502 bad gateway"),
		);

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

	it("User with SMS-only opt-in receives SMS but no email on AAPL 5% gap", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id, { email: false, sms: true });

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.emailsSent).toBe(0);
		expect(totals.smsSent).toBe(1);
		expect(mockEmailSender).not.toHaveBeenCalled();
		expect(mockSmsSender).toHaveBeenCalledOnce();

		const smsCall = mockSmsSender.mock.calls[0]?.[0] as { body: string };
		expect(smsCall.body).toContain("AAPL");
		expect(smsCall.body).toContain("5% Price Move");
		expect(smsCall.body).toContain("Reply STOP");
	});

	it("User with both channels on receives both email and SMS on a 5% gap", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		await enableFlatAlerts(testUser.id, { email: true, sms: true });

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.emailsSent).toBe(1);
		expect(totals.smsSent).toBe(1);
		expect(mockEmailSender).toHaveBeenCalledOnce();
		expect(mockSmsSender).toHaveBeenCalledOnce();

		// Two notification_log rows — one per channel
		expect(await getNotificationLogCount(testUser.id)).toBe(2);
	});

	it("User opted into SMS but phone unverified: SMS skipped as ineligible", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);
		// Turn on SMS intent but leave phone unverified
		const { error } = await adminClient
			.from("users")
			.update({
				price_move_alerts_include_email: false,
				price_move_alerts_include_sms: true,
				sms_notifications_enabled: true,
				phone_verified: false,
				phone_country_code: "+1",
				phone_number: "5555550123",
			})
			.eq("id", testUser.id);
		if (error) throw new Error(`setup failed: ${error.message}`);

		const quoteMap = new Map([["AAPL", makeQuote({ price: 195.86 })]]);

		const totals = await processFlatPriceAlerts({
			supabase: adminClient,
			quoteMap,
			isMarketOpen: true,
		});

		expect(totals.alertsTriggered).toBe(1);
		expect(totals.smsSent).toBe(0);
		expect(totals.smsFailed).toBe(1);
		expect(mockSmsSender).not.toHaveBeenCalled();
		expect(mockEmailSender).not.toHaveBeenCalled();
	});
});
