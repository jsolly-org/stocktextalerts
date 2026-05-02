/**
 * Tests that when staged delivery fails (throws), fallback still runs.
 * Uses a scoped spy so we can simulate the failure path without affecting other tests.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import { runScheduledNotifications } from "../../../src/lib/schedule/run";
import * as deliverModule from "../../../src/lib/staged-notifications/deliver";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../setup";

describe("runScheduledNotifications: staging failure fallback", () => {
	beforeEach(() => {
		expectConsoleError("Staged delivery phase failed (falling back to full pipeline)");
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		vi.spyOn(deliverModule, "deliverStagedNotifications").mockRejectedValue(
			new Error("Simulated staged delivery failure"),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("fallback still delivers when staged delivery phase throws", async () => {
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

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});
});
