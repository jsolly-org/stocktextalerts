import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { calculateDailyNotificationNextSendAtIso } from "../../../../src/lib/daily-notification/schedule";
import { getUsBeforeOpenLocalMinutes } from "../../../../src/lib/time/conversion";
import { POST as POSTDismissBanner } from "../../../../src/pages/api/profile/dismiss-timezone-banner";
import { POST as POSTTimezone } from "../../../../src/pages/api/profile/timezone";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser, setTestUserPrefs } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user dismisses the timezone mismatch banner.", () => {
	it("The banner dismissal is saved so it no longer appears.", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const request = new Request("http://localhost/api/profile/dismiss-timezone-banner", {
			method: "POST",
		});

		const response = await POSTDismissBanner(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.message).toBe("timezone_banner_dismissed");

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("dismiss_timezone_mismatch_prompts")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser?.dismiss_timezone_mismatch_prompts).toBe(true);
	});
});

describe("A signed-in user updates their timezone.", () => {
	it("The new timezone is saved and the user sees a confirmation.", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("timezone", "Etc/UTC");

		const request = new Request("http://localhost/api/profile/timezone", {
			method: "POST",
			body: formData,
		});

		const response = await POSTTimezone(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.message).toBe("timezone_updated");
		expect(json.notificationPreferences.timezone).toBe("Etc/UTC");

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("timezone")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser?.timezone).toBe("Etc/UTC");
	});

	it("Timezone change locks daily_notification_time to 09:00 ET in the new zone and keeps the UTC digest instant.", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-next-send-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
			scheduledUpdateTimes: [540],
			trackedAssets: ["SPY"],
		});
		registerTestUserForCleanup(testUser.id);

		const nextIso = calculateDailyNotificationNextSendAtIso({
			now: DateTime.utc(),
			hasDailyNotification: true,
		});
		const { error: dailyDigestError } = await adminClient
			.from("users")
			.update({
				daily_notification_time: 540,
				daily_notification_next_send_at: nextIso,
			})
			.eq("id", testUser.id);
		expect(dailyDigestError).toBeNull();
		await setTestUserPrefs(testUser.id, [["daily_notification", "news", true]]);

		const { data: beforeUpdate } = await adminClient
			.from("users")
			.select("market_scheduled_asset_price_next_send_at,daily_notification_next_send_at")
			.eq("id", testUser.id)
			.single();
		expect(beforeUpdate).not.toBeNull();

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("timezone", "America/Los_Angeles");

		const request = new Request("http://localhost/api/profile/timezone", {
			method: "POST",
			body: formData,
		});

		const response = await POSTTimezone(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.notificationPreferences.timezone).toBe("America/Los_Angeles");
		expect(json.notificationPreferences.market_scheduled_asset_price_next_send_at).toBeTruthy();
		expect(json.notificationPreferences.daily_notification_next_send_at).toBeTruthy();

		const { data: afterUpdate } = await adminClient
			.from("users")
			.select(
				"timezone,daily_notification_time,market_scheduled_asset_price_next_send_at,daily_notification_next_send_at",
			)
			.eq("id", testUser.id)
			.single();

		expect(afterUpdate?.timezone).toBe("America/Los_Angeles");
		expect(afterUpdate?.daily_notification_time).toBe(
			getUsBeforeOpenLocalMinutes("America/Los_Angeles"),
		);
		expect(afterUpdate?.daily_notification_time).not.toBe(540);
		expect(afterUpdate?.market_scheduled_asset_price_next_send_at).toBe(
			beforeUpdate?.market_scheduled_asset_price_next_send_at,
		);
		expect(afterUpdate?.daily_notification_next_send_at).toBe(
			beforeUpdate?.daily_notification_next_send_at,
		);
	});
});
