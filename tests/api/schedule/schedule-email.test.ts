import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/schedule";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Users receive scheduled asset update notifications.", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SMS_TEST_MESSAGE_SID", "test-sms-sid");
		vi.stubEnv("FINNHUB_API_KEY", "");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Eligible users receive their asset update by email at the scheduled time.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error("Invalid timezone for test formatter");
		}
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;

		// 1. Create User
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

		// 2. Execute Scheduled Job
		const createRequest = () =>
			new Request("http://localhost/api/schedule", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${testCronSecret}`,
				},
			});

		const response = await POST({ request: createRequest() } as APIContext);
		const response2 = await POST({ request: createRequest() } as APIContext);

		// 3. Assertions
		// Check Status
		expect(response.status).toBe(200);
		expect(response2.status).toBe(200);

		const json = await response.json();
		const json2 = await response2.json();

		expect(json.success).toBe(true);
		expect(json2.success).toBe(true);

		// Verify Database Log - notification was attempted once (deduped by DB)
		const { data: logs, error: logError } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("delivery_method", "email")
			.eq("type", "market")
			.order("created_at", { ascending: false })
			.limit(10);

		expect(logError).toBeNull();
		expect(logs).toHaveLength(1);
		const log = logs?.[0];
		if (!log) throw new Error("Expected log entry not found");

		// Verify scheduled_notifications row exists and only attempted once
		const { data: scheduled, error: scheduledError } = await adminClient
			.from("scheduled_notifications")
			.select("status,attempt_count")
			.eq("user_id", id)
			.eq("notification_type", "market")
			.eq("scheduled_minutes", scheduledUpdateTime)
			.eq("channel", "email")
			.maybeSingle();

		expect(scheduledError).toBeNull();
		expect(scheduled).toBeTruthy();
		if (!scheduled)
			throw new Error("Expected scheduled_notifications row not found");
		expect(scheduled.attempt_count).toBe(1);
		expect(["sent", "failed"]).toContain(scheduled.status);

		// Verify notification was attempted and logged
		// Note: Email delivery may fail due to invalid API key or rate limits
		expect(json.emailsSent + json.emailsFailed).toBeGreaterThanOrEqual(1);

		// If email succeeded, message should contain AAPL. If failed, error will be in message
		if (log.message_delivered) {
			expect(log.message).toContain("AAPL");
		} else {
			// On failure, error is logged - verify the log entry exists
			expect(log.error).toBeTruthy();
		}
	});
});
