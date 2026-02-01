import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/notifications/scheduled";
import {
	adminClient,
	cleanupTestUser,
	createTestUser,
} from "../../shared-utils";

describe("Users receive scheduled daily digest notifications.", () => {
	const testCronSecret = "test-cron-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SMS_TEST_MESSAGE_SID", "test-sms-sid");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Eligible users receive their daily digest by SMS at the scheduled time.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error("Invalid timezone for test formatter");
		}
		const dailyDigestNotificationTime = nowLocal.hour * 60 + nowLocal.minute;

		let id: string | undefined;
		try {
			vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
			vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
			vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");

			const user = await createTestUser({
				timezone,
				emailNotificationsEnabled: false,
				smsNotificationsEnabled: true,
				phoneVerified: true,
				smsOptedOut: false,
				dailyDigestEnabled: true,
				dailyDigestNotificationTimes: [dailyDigestNotificationTime],
				trackedStocks: ["AAPL"],
			});
			id = user.id;

			const { error: updateError } = await adminClient
				.from("users")
				.update({ next_send_at: DateTime.utc().toISO() })
				.eq("id", id);
			expect(updateError).toBeNull();

			const response = await POST({
				request: new Request("http://localhost/api/notifications/scheduled", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${testCronSecret}`,
					},
				}),
			} as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.success).toBe(true);
			expect(json.smsSent + json.smsFailed).toBeGreaterThanOrEqual(1);

			const { data: logs, error: logError } = await adminClient
				.from("notification_log")
				.select("*")
				.eq("user_id", id)
				.eq("delivery_method", "sms")
				.eq("type", "scheduled_update")
				.order("created_at", { ascending: false })
				.limit(10);
			expect(logError).toBeNull();
			expect(logs).toHaveLength(1);
			expect(logs[0].message_delivered).toBe(true);

			const { data: scheduled, error: scheduledError } = await adminClient
				.from("scheduled_notifications")
				.select("status,attempt_count")
				.eq("user_id", id)
				.eq("notification_type", "daily_digest")
				.eq("scheduled_minutes", dailyDigestNotificationTime)
				.eq("channel", "sms")
				.maybeSingle();
			expect(scheduledError).toBeNull();
			expect(scheduled).toBeTruthy();
			expect(scheduled.attempt_count).toBe(1);
			expect(["sent", "failed"]).toContain(scheduled.status);
		} finally {
			vi.unstubAllEnvs();
			if (id) await cleanupTestUser(id);
		}
	});
});
