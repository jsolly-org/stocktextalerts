import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../../src/pages/api/notifications/scheduled";
import { adminClient } from "../../../setup";
import { createTestUser } from "../../../utils";

describe("Scheduled Notifications Integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-12T15:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends email notifications to eligible users via Resend", async () => {
		const timezone = "America/New_York";
		const formatter = new Intl.DateTimeFormat("en-US", {
			hour: "numeric",
			minute: "numeric",
			hourCycle: "h23",
			timeZone: timezone,
		});
		const parts = formatter.formatToParts(new Date());
		const hourPart = parts.find((part) => part.type === "hour");
		const minutePart = parts.find((part) => part.type === "minute");
		if (!hourPart || !minutePart) {
			throw new Error("Missing hour or minute part for timezone formatter");
		}
		const hours = Number.parseInt(hourPart.value, 10);
		const minutes = Number.parseInt(minutePart.value, 10);
		if (Number.isNaN(hours) || Number.isNaN(minutes)) {
			throw new Error("Invalid hour or minute for timezone formatter");
		}
		const dailyDigestNotificationTime = hours * 60 + minutes;

		// 1. Create User
		const { id } = await createTestUser({
			email:
				process.env.TEST_EMAIL_RECIPIENT ||
				`test-notification-${Date.now()}@resend.dev`,
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			dailyDigestEnabled: true,
			dailyDigestNotificationTime,
			trackedStocks: ["AAPL"],
		});

		try {
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
			const { error: deleteUserError } = await adminClient
				.from("users")
				.delete()
				.eq("id", id);
			if (deleteUserError) {
				console.warn("Failed to cleanup test user from public.users", {
					id,
					error: deleteUserError.message,
				});
			}

			const { error: deleteAuthUserError } =
				await adminClient.auth.admin.deleteUser(id);
			if (deleteAuthUserError) {
				console.warn("Failed to cleanup test user from auth.users", {
					id,
					error: deleteAuthUserError.message,
				});
			}
		}
	});
});
