/**
 * Tests that when staged delivery fails (throws), fallback still runs.
 * Uses a mock so we can simulate the failure path without affecting other tests.
 */
import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/schedule";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { allowConsoleErrors } from "../../setup";

vi.mock("../../../src/lib/staged-notifications/deliver", () => ({
	deliverStagedNotifications: () => {
		throw new Error("Simulated staged delivery failure");
	},
}));

describe("runScheduledNotifications: staging failure fallback", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		allowConsoleErrors();
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
	});

	afterEach(() => {
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

		const createRequest = () =>
			new Request("http://localhost/api/schedule", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${testCronSecret}`,
				},
			});

		const response = await POST({ request: createRequest() } as APIContext);
		expect(response.status).toBe(200);

		const { data: logs } = await adminClient
			.from("notification_log")
			.select("id")
			.eq("user_id", id)
			.eq("type", "market");

		expect(logs?.length).toBeGreaterThanOrEqual(1);
	});
});
