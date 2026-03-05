import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/schedule";
import { createApiContext } from "../../helpers/api-context";
import { createCronRequest } from "../../helpers/cron";
import { isLiveProviderEnabled } from "../../helpers/live-api";
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
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Eligible users receive their asset update by SMS at the scheduled time.", async () => {
		const timezone = "America/New_York";
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error("Invalid timezone for test formatter");
		}
		const scheduledUpdateTime = nowLocal.hour * 60 + nowLocal.minute;

		// Only stub fake Twilio credentials when not in live SMS mode.
		// vi.stubEnv affects import.meta.env in source code, so stubbing fake
		// credentials would break real Twilio API calls in live mode.
		if (!isLiveProviderEnabled("sms")) {
			vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
			vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
			vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");
		}

		const user = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			smsOptedOut: false,
			scheduledUpdateTimes: [scheduledUpdateTime],
			trackedAssets: ["AAPL"],
		});
		const { id } = user;
		registerTestUserForCleanup(id);

		const { error: updateError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
				market_scheduled_asset_price_enabled: true,
			})
			.eq("id", id);
		expect(updateError).toBeNull();

		const response = await POST(
			createApiContext({
				request: createCronRequest({
					path: "/api/schedule",
					cronSecret: testCronSecret,
				}),
			}),
		);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.success).toBe(true);
		expect(json.smsSent + json.smsFailed).toBeGreaterThanOrEqual(1);

		const { data: logs, error: logError } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("delivery_method", "sms")
			.eq("type", "market")
			.order("created_at", { ascending: false })
			.limit(10);
		expect(logError).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs[0].message_delivered).toBe(true);

		const { data: scheduled, error: scheduledError } = await adminClient
			.from("scheduled_notifications")
			.select("status,attempt_count")
			.eq("user_id", id)
			.eq("notification_type", "market")
			.eq("scheduled_minutes", scheduledUpdateTime)
			.eq("channel", "sms")
			.maybeSingle();
		expect(scheduledError).toBeNull();
		expect(scheduled).toBeTruthy();
		expect(scheduled.attempt_count).toBe(1);
		expect(["sent", "failed"]).toContain(scheduled.status);
	});
});
