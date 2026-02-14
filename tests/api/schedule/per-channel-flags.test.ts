import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/schedule";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Tests that per-channel include flags (market_scheduled_asset_price_include_email, market_scheduled_asset_price_include_sms)
 * correctly gate delivery for scheduled price updates.
 *
 * These flags were introduced so users can enable a notification channel (e.g. email)
 * but opt out of specific notification types on that channel.
 */
describe("Per-channel include flags gate scheduled notification delivery.", () => {
	const testCronSecret = "test-cron-secret";
	const timezone = "America/New_York";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO("2026-01-12T15:00:00.000Z").toJSDate());
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("SMS_TEST_MESSAGE_SID", "test-sms-sid");
		vi.stubEnv("FINNHUB_API_KEY", "");
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	function createRequest() {
		return new Request("http://localhost/api/schedule", {
			method: "POST",
			headers: { Authorization: `Bearer ${testCronSecret}` },
		});
	}

	it("No email is sent when email_notifications_enabled=true but market_scheduled_asset_price_include_email=false.", async () => {
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) throw new Error("Invalid timezone");
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: false,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
			})
			.eq("id", id);

		const response = await POST({ request: createRequest() } as APIContext);
		expect(response.status).toBe(200);

		// No email notification should have been logged
		const { data: logs } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "email");

		expect(logs ?? []).toHaveLength(0);
	});

	it("No SMS is sent when sms_notifications_enabled=true but market_scheduled_asset_price_include_sms=false.", async () => {
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) throw new Error("Invalid timezone");
		const scheduledTime = nowLocal.hour * 60 + nowLocal.minute;

		const { id } = await createTestUser({
			timezone,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			scheduledUpdateTimes: [scheduledTime],
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeSms: false,
		});
		registerTestUserForCleanup(id);

		await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_next_send_at: DateTime.utc().toISO(),
			})
			.eq("id", id);

		const response = await POST({ request: createRequest() } as APIContext);
		expect(response.status).toBe(200);

		// No SMS notification should have been logged
		const { data: logs } = await adminClient
			.from("notification_log")
			.select("*")
			.eq("user_id", id)
			.eq("type", "market")
			.eq("delivery_method", "sms");

		expect(logs ?? []).toHaveLength(0);
	});
});
