import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/notifications/scheduled";
import { adminClient } from "../setup";
import { cleanupTestUser, createTestUser } from "../utils";

describe("Scheduled Notifications Integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends email notifications to eligible users via Resend", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error("Invalid timezone for test formatter");
		}
		const dailyDigestNotificationTime = nowLocal.hour * 60 + nowLocal.minute;

		// 1. Create User
		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			dailyDigestEnabled: true,
			dailyDigestNotificationTimes: [dailyDigestNotificationTime],
			trackedStocks: ["AAPL"],
		});

		try {
			const { error: updateError } = await adminClient
				.from("users")
				.update({ next_send_at: DateTime.utc().toISO() })
				.eq("id", id);
			expect(updateError).toBeNull();

			// 2. Execute Scheduled Job
			const cronSecret = process.env.CRON_SECRET;
			if (!cronSecret) {
				throw new Error(
					"CRON_SECRET environment variable must be set for this test",
				);
			}
			// Ensure environment matches (mocking request header is enough if app checks env)

			const createRequest = () =>
				new Request("http://localhost/api/notifications/scheduled", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${cronSecret}`,
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
				.eq("type", "scheduled_update")
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
				.eq("notification_type", "daily_digest")
				.eq("scheduled_minutes", dailyDigestNotificationTime)
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
		} finally {
			await cleanupTestUser(id);
		}
	});

	it("sends SMS notifications to eligible users", async () => {
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

			const cronSecret = process.env.CRON_SECRET;
			if (!cronSecret) {
				throw new Error(
					"CRON_SECRET environment variable must be set for this test",
				);
			}

			const response = await POST({
				request: new Request("http://localhost/api/notifications/scheduled", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${cronSecret}`,
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
			if (!scheduled)
				throw new Error("Expected scheduled_notifications row not found");
			expect(scheduled.attempt_count).toBe(1);
			expect(["sent", "failed"]).toContain(scheduled.status);
		} finally {
			try {
				if (id) await cleanupTestUser(id);
			} finally {
				vi.unstubAllEnvs();
			}
		}
	});

	it("rejects requests without the cron secret", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/notifications/scheduled", {
				method: "POST",
			}),
		} as APIContext);

		expect(response.status).toBe(401);
	});
});
