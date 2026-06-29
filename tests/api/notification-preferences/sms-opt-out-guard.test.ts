import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/notification-preferences/update";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser, generateUniquePhoneNumber } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/** Read a single per-option preference's enabled state from notification_preferences. */
async function readPref(
	userId: string,
	notificationType: string,
	content: string,
	channel: string,
): Promise<boolean | null> {
	const { data } = await adminClient
		.from("notification_preferences")
		.select("enabled")
		.eq("user_id", userId)
		.eq("notification_type", notificationType)
		.eq("content", content)
		.eq("channel", channel)
		.maybeSingle();
	return data?.enabled ?? null;
}

describe("A signed-in opted-out user attempts to re-enable SMS options.", () => {
	it("When sms_opted_out is true, SMS include flags cannot be enabled.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			smsNotificationsEnabled: false,
			smsOptedOut: true,
			phoneVerified: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_sms", "true");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("sms_opted_out");

		expect(await readPref(testUser.id, "market_asset_price_alerts", "", "sms")).toBe(false);
	});

	it("When sms_opted_out is true, submitting already-enabled SMS include flags still allows unrelated saves.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			smsNotificationsEnabled: false,
			smsOptedOut: true,
			phoneVerified: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
			marketScheduledAssetPriceIncludeSms: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		// Mirrors hidden SMS field submission while saving an unrelated preference.
		formData.append("market_scheduled_asset_price_include_sms", "true");
		formData.append("daily_digest_include_news_email", "true");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");

		expect(await readPref(testUser.id, "market_scheduled_asset_price", "", "sms")).toBe(true);
		expect(await readPref(testUser.id, "daily_notification", "news", "email")).toBe(true);
	});
});
