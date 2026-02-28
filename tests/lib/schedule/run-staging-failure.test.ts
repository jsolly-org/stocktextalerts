/**
 * Tests that when staged delivery fails (throws), fallback still runs.
 * Uses a scoped spy so we can simulate the failure path without affecting other tests.
 */
import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import * as deliverModule from "../../../src/lib/staged-notifications/deliver";
import { POST } from "../../../src/pages/api/schedule";
import { createScheduleRequest } from "../../helpers/schedule-request";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../setup";

describe("runScheduledNotifications: staging failure fallback", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		expectConsoleError(
			"Staged delivery phase failed (falling back to full pipeline)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		vi.spyOn(deliverModule, "deliverStagedNotifications").mockRejectedValue(
			new Error("Simulated staged delivery failure"),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("fallback still delivers when staged delivery phase throws", async () => {
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

		const response = await POST({
			request: createScheduleRequest(testCronSecret),
		} as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});
});
