/**
 * Vitest tests for the run.ts scheduled notification runner.
 *
 * Covers: fallback still delivers when no staging row exists for a user
 * (the only path now that scheduled-market delivery runs inline), plus
 * session-aware labeling (pre/regular/after) and the closed-session skip
 * path that advances next_send_at without sending.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market/calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

const { getCurrentMarketSessionMock } = vi.hoisted(() => ({
	getCurrentMarketSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/market-data/session", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/session")>(
		"../../../src/lib/market-data/session",
	);
	return {
		...actual,
		getCurrentMarketSession: getCurrentMarketSessionMock,
	};
});

vi.mock("../../../src/lib/market-data/prices", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/prices")>(
		"../../../src/lib/market-data/prices",
	);
	return {
		...actual,
		// Synthetic happy-path quotes for run-test scenarios (these tests
		// assert on session-aware labeling/headers, not on the Massive call
		// itself). Only the functions run.ts actually calls are mocked —
		// fetchAssetPricesWithSessionState and fetchExtendedQuotes; the
		// fetchAssetPrices entry point is unused in this Lambda path.
		fetchAssetPricesWithSessionState: vi.fn(async (symbols: string[]) => ({
			prices: new Map(
				symbols.map((s) => [s, { price: 150.0, changePercent: 1.25, prevClose: 148.5 }]),
			),
			noSessionTrade: new Set<string>(),
		})),
		fetchExtendedQuotes: vi.fn(
			async (symbols: string[]) =>
				new Map(
					symbols.map((s) => [
						s,
						{
							price: 150.0,
							changePercent: 1.25,
							dayHigh: 152.0,
							dayLow: 148.0,
							dayOpen: 149.0,
							prevClose: 148.5,
							timestamp: Math.floor(Date.now() / 1000),
							volume: null,
						},
					]),
				),
		),
	};
});

vi.mock("../../../src/lib/market-data/sparklines", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/market-data/sparklines")>(
		"../../../src/lib/market-data/sparklines",
	);
	return {
		...actual,
		// Deterministic intraday sparkline so the prev-close-anchored headline
		// change-% (the sparkline's first->last delta) is stable. Endpoints
		// 148.5 -> 150 = +1.01%, matching the mocked prevClose/price above.
		fetchIntradaySparklines: vi.fn(
			async (symbols: string[]) =>
				new Map(
					symbols.map((s) => [
						s,
						{
							values: [148.5, 149.0, 149.5, 150.0],
							ascii: "▁▃▅▇",
							window: "intraday-since-prev-close" as const,
						},
					]),
				),
		),
	};
});

import { runScheduledNotifications } from "../../../src/lib/schedule/run";
import { resetMarketSessionCache } from "../../helpers/reset-market-session-cache";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

interface NotificationLogRow {
	id: string;
	message: string | null;
	message_delivered: boolean;
	delivery_method: string;
}

async function fetchMarketLogs(userId: string): Promise<NotificationLogRow[]> {
	const { data, error } = await adminClient
		.from("notification_log")
		.select("id, message, message_delivered, delivery_method")
		.eq("user_id", userId)
		.eq("type", "market");
	if (error) throw new Error(`fetchMarketLogs failed: ${error.message}`);
	return (data ?? []) as NotificationLogRow[];
}

async function fetchUserNextSendAt(userId: string): Promise<string | null> {
	const { data, error } = await adminClient
		.from("users")
		.select("market_scheduled_asset_price_next_send_at")
		.eq("id", userId)
		.single();
	if (error) throw new Error(`fetchUserNextSendAt failed: ${error.message}`);
	return data?.market_scheduled_asset_price_next_send_at ?? null;
}

describe("runScheduledNotifications: fallback pipeline", () => {
	beforeEach(() => {
		resetMarketSessionCache();
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		// Default to a regular-hours session so callers that don't override
		// keep their prior behavior. Individual tests override per scenario.
		getCurrentMarketSessionMock.mockReset();
		getCurrentMarketSessionMock.mockResolvedValue("regular");
	});

	afterEach(() => {
		// Do not call vi.unstubAllEnvs() — it strips global Twilio stubs from
		// tests/setup.ts. Email-only cases never call getSmsSender(), so the first
		// SMS test would fail on CI where .env.local lacks TWILIO_API_KEY_*.
		// beforeEach re-stubs SMS_TEST_BEHAVIOR and SCHEDULE_PASS_DELAY_MS each test.
	});

	it("fallback still delivers when no staging row exists for the user", async () => {
		const timezone = "America/New_York";
		const fixedDueAt = DateTime.fromISO("2026-01-12T15:00:00.000Z", {
			zone: "utc",
		});
		const dueAtLocal = fixedDueAt.setZone(timezone);
		const scheduledUpdateTime = dueAtLocal.hour * 60 + dueAtLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		const logs = await fetchMarketLogs(id);
		expect(logs.length).toBeGreaterThanOrEqual(1);
	});

	it("A user with a 7:00 AM ET pre-market scheduled time receives a message labeled 'Pre-market' with change-% emitted", async () => {
		const timezone = "America/New_York";
		// 7:00 AM ET on a winter weekday (EST = UTC-5) → 12:00 UTC.
		const fixedDueAt = DateTime.fromISO("2026-01-12T12:00:00.000Z", {
			zone: "utc",
		});
		const scheduledUpdateTime = 7 * 60; // 7:00 AM ET = 420 min

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		getCurrentMarketSessionMock.mockResolvedValue("pre");

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		const logs = await fetchMarketLogs(id);
		expect(logs.length).toBeGreaterThanOrEqual(1);
		const emailLog = logs.find((l) => l.delivery_method === "email");
		expect(emailLog).toBeDefined();
		expect(emailLog?.message_delivered).toBe(true);
		expect(emailLog?.message).toMatch(/^Pre-market — /);
		// Change-% derives from the sparkline endpoints (prevClose 148.5 →
		// appended live price 150 = +1.01%), keeping it in lockstep with the chart.
		expect(emailLog?.message).toContain("1.01%");
		// Pre-market sessions use the same prev-close-anchored intraday chart as
		// RTH/AH — Massive's 5-minute bars endpoint returns pre-market bars from
		// 4 AM ET, and prepending prev close makes the chart's first-to-last
		// delta agree with the headline change-%. SMS-style label is "today".
		expect(emailLog?.message).toContain("today:");
		expect(emailLog?.message).not.toContain("past 7 days:");
	});

	it("A user with a 5:00 PM ET after-hours scheduled time receives a message labeled 'After-hours' with prev-close-anchored change-%", async () => {
		const timezone = "America/New_York";
		// 5:00 PM ET on a winter weekday (EST = UTC-5) → 22:00 UTC.
		const fixedDueAt = DateTime.fromISO("2026-01-12T22:00:00.000Z", {
			zone: "utc",
		});
		const scheduledUpdateTime = 17 * 60; // 5:00 PM ET = 1020 min

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		getCurrentMarketSessionMock.mockResolvedValue("after");

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		const logs = await fetchMarketLogs(id);
		expect(logs.length).toBeGreaterThanOrEqual(1);
		const emailLog = logs.find((l) => l.delivery_method === "email");
		expect(emailLog).toBeDefined();
		expect(emailLog?.message_delivered).toBe(true);
		expect(emailLog?.message).toMatch(/^After-hours — /);
		// Header is anchored to yesterday's close (retail-app convention). The
		// sparkline prepends yesterday's close and appends the live price, and
		// the headline change-% derives from those same endpoints
		// (148.5 → 150 = +1.01%), so chart and % can never disagree.
		expect(emailLog?.message).toContain("1.01%");
		// After-hours session shows the today (prev-close-anchored) sparkline so
		// shape and color always agree with the headline %; SMS label is "today".
		expect(emailLog?.message).toContain("today:");
		// No legacy 4 PM-close anchor in the header.
		expect(emailLog?.message).not.toContain("vs. 4:00 PM close");
	});

	it("An SMS-only user receives an after-hours SMS with prev-close-anchored change-% and no 4 PM-close header anchor", async () => {
		const timezone = "America/New_York";
		const fixedDueAt = DateTime.fromISO("2026-01-12T22:00:00.000Z", {
			zone: "utc",
		});
		const scheduledUpdateTime = 17 * 60;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		getCurrentMarketSessionMock.mockResolvedValue("after");

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		const logs = await fetchMarketLogs(id);
		const smsLog = logs.find((l) => l.delivery_method === "sms");
		expect(smsLog).toBeDefined();
		expect(smsLog?.message_delivered).toBe(true);
		// Header has session label only — no 4 PM-close anchor parenthetical.
		expect(smsLog?.message).toMatch(/After-hours — \d+:\d{2} (AM|PM) ET/);
		expect(smsLog?.message).not.toContain("vs. 4:00 PM close");
		// Change-% derives from the sparkline endpoints (prev-close anchored):
		// 148.5 → 150 = +1.01%.
		expect(smsLog?.message).toContain("1.01%");
	});

	it("A scheduled time on a half-day in the after-hours dead zone is skipped at delivery (runtime session = 'closed'), logged at 'info', next_send_at advances", async () => {
		const timezone = "America/New_York";
		// 2:00 PM ET on a winter weekday → 19:00 UTC. Half-day after 1pm
		// scenario: Massive reports session "closed" so we skip without
		// sending, and the row's next_send_at advances to a future slot.
		const fixedDueAt = DateTime.fromISO("2026-01-12T19:00:00.000Z", {
			zone: "utc",
		});
		const scheduledUpdateTime = 14 * 60; // 2:00 PM ET = 840 min

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		getCurrentMarketSessionMock.mockResolvedValue("closed");

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		// No notification rows should be created for this user.
		const logs = await fetchMarketLogs(id);
		expect(logs).toHaveLength(0);

		// Skip log line was emitted at info.
		const infoCalls = logger.info.mock.calls.map((args) => args[0] as string);
		expect(
			infoCalls.some(
				(line) => typeof line === "string" && line.includes("Skipping scheduled market delivery"),
			),
		).toBe(true);

		// next_send_at advanced past the original due time.
		const newNextSendAt = await fetchUserNextSendAt(id);
		expect(newNextSendAt).not.toBeNull();
		const advanced = DateTime.fromISO(newNextSendAt as string, { zone: "utc" });
		expect(advanced.toMillis()).toBeGreaterThan(fixedDueAt.toMillis());
	});

	it("A 9:31 AM ET regular-session send produces a regular-hours message", async () => {
		// createTestUser rounds local minutes to a 15-min grid, so seed with
		// 9:30 AM ET (the closest representable slot that exercises the
		// regular-session label without DST drift).
		const timezone = "America/New_York";
		// 9:30 AM ET on a winter weekday → 14:30 UTC.
		const fixedDueAt = DateTime.fromISO("2026-01-12T14:30:00.000Z", {
			zone: "utc",
		});
		const scheduledUpdateTime = 9 * 60 + 30; // 9:30 AM ET = 570 min

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: fixedDueAt.toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		getCurrentMarketSessionMock.mockResolvedValue("regular");

		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		await runScheduledNotifications({
			supabase: adminClient,
			logger: logger as never,
		});

		const logs = await fetchMarketLogs(id);
		expect(logs.length).toBeGreaterThanOrEqual(1);
		const emailLog = logs.find((l) => l.delivery_method === "email");
		expect(emailLog).toBeDefined();
		expect(emailLog?.message_delivered).toBe(true);
		expect(emailLog?.message).toMatch(/^Regular hours — /);
	});
});
