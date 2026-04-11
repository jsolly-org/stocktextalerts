/**
 * Vitest tests for the run.ts scheduled notification runner.
 *
 * Covers: fallback phase skips users already delivered by staging (no double-send),
 * and fallback still delivers when staging has no rows (missing/invalid path).
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import { runScheduledNotifications } from "../../../src/lib/schedule/run";
import { upsertStagedNotification } from "../../../src/lib/staged-notifications/db";
import type { StagedMarketData } from "../../../src/lib/staged-notifications/types";
import { toIsoOrThrow } from "../../../src/lib/time/format";
import { isLiveProviderEnabled } from "../../helpers/live-api";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("runScheduledNotifications: staged + fallback pipeline", () => {
	// Fake timers are incompatible with live SES sends: AWS SDK v3 signs SES
	// requests with Date.now(), and vi.useFakeTimers() freezes the clock to a
	// fixed instant that falls outside AWS's 15-minute signing window. The SES
	// call then hangs on a signature the service silently rejects. Skip fake
	// timers under --live=email so real SES calls succeed; offline mode still
	// gets a deterministic clock.
	const useFakeTimers = !isLiveProviderEnabled("email");

	beforeEach(() => {
		if (useFakeTimers) {
			vi.useFakeTimers();
			vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		}
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
	});

	afterEach(() => {
		if (useFakeTimers) {
			vi.useRealTimers();
		}
		vi.unstubAllEnvs();
	});

	it("fallback does not process users already delivered by staging (no double-send)", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;
		const scheduledDate = nowLocal.toISODate() ?? "2026-01-12";

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
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const stagedData: StagedMarketData = {
			type: "market",
			scheduledDate,
			scheduledMinutes: scheduledUpdateTime,
			marketOpen: true,
			email: {
				subject: "Staged subject",
				text: "AAPL staged",
				html: "<p>AAPL staged</p>",
			},
			sms: null,
		};

		const scheduledFor = toIsoOrThrow(DateTime.utc(), "scheduledFor");
		const { error: upsertError } = await upsertStagedNotification(adminClient, {
			userId: id,
			notificationType: "market",
			scheduledFor,
			stagedData,
		});
		expect(upsertError).toBeNull();

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

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBe(1);
	});

	it("fallback still delivers when staging has no rows (staging missing path)", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;

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
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
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

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});
});
