import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getCurrentNotificationPreferences } from "../../../../src/pages/api/notification-preferences/current";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user loads their current notification settings.", () => {
	it("Returns the saved notification preferences snapshot for dashboard hydration.", async () => {
		// Helper takes user-local minutes and converts to ET-canonical at the
		// boundary (matches the API behavior). 555 CST = 9:15 AM CST = 10:15 AM
		// ET = 615; 900 CST = 3:00 PM CST = 4:00 PM ET = 960.
		const testUser = await createTestUser({
			email: `pref-current-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/Chicago",
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			scheduledUpdateTimes: [555, 900],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const response = await getCurrentNotificationPreferences(
			createApiContext({
				request: new Request("http://localhost/api/notification-preferences/current", {
					method: "GET",
				}),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				email_notifications_enabled: boolean;
				sms_notifications_enabled: boolean;
				timezone: string;
				market_scheduled_asset_price_times: number[] | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("ok");
		expect(payload.notificationPreferences.email_notifications_enabled).toBe(true);
		expect(payload.notificationPreferences.sms_notifications_enabled).toBe(false);
		expect(payload.notificationPreferences.timezone).toBe("America/Chicago");
		expect(payload.notificationPreferences.market_scheduled_asset_price_times).toEqual([615, 960]);
	});

	it("Rejects a logged-out request.", async () => {
		const response = await getCurrentNotificationPreferences(
			createApiContext({
				request: new Request("http://localhost/api/notification-preferences/current", {
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
