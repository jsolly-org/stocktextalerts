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

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

const { getCurrentMarketSessionMock } = vi.hoisted(() => ({
	getCurrentMarketSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/providers/price-fetcher")>(
		"../../../src/lib/providers/price-fetcher",
	);
	return {
		...actual,
		getCurrentMarketSession: getCurrentMarketSessionMock,
	};
});

import { runScheduledNotifications } from "../../../src/lib/schedule/run";
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
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		// Default to a regular-hours session so callers that don't override
		// keep their prior behavior. Individual tests override per scenario.
		getCurrentMarketSessionMock.mockReset();
		getCurrentMarketSessionMock.mockResolvedValue("regular");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
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
		// Change-% line emitted for the test's stub price (changePercent: 1.25).
		expect(emailLog?.message).toContain("1.25%");
	});

	it("A user with a 5:00 PM ET after-hours scheduled time receives a message labeled 'After-hours' with change-% emitted", async () => {
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
		expect(emailLog?.message).toContain("1.25%");
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

	it.skip("On a half-day after 1:00 PM ET, if Massive returns 'after', behavior is TBD pending live verification", () => {
		// TODO(half-day-verification): resolve before final commit, by 2026-05-15.
		// Open question: on early-close days, does Massive flip to
		// `afterHours: true` immediately at the 1:00 PM close, or do they
		// honor the regular 4:00 PM after-hours boundary? Resolving this
		// requires live observation on a real half-day; skip until then.
	});
});
