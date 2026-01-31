import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/api/preferences/current";
import {
	cleanupTestUser,
	createAuthenticatedCookies,
	createTestUser,
} from "../utils";

const TEST_PASSWORD = "TestPassword123!";

describe("GET /api/preferences/current", () => {
	it("returns the current user's preferences", async () => {
		const testUser = await createTestUser({
			email: `prefs-${Date.now()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			smsOptedOut: false,
			timezone: "America/Los_Angeles",
			dailyDigestEnabled: true,
			dailyDigestNotificationTimes: [480],
		});

		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);
			const request = new Request("http://localhost/api/preferences/current");

			const response = await GET({
				request,
				cookies: {
					get: (name: string) => {
						const value = cookies.get(name);
						return value ? { value } : undefined;
					},
					set: () => {},
				},
			} as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.ok).toBe(true);
			expect(json.preferences).toBeDefined();
			expect(json.preferences.email_notifications_enabled).toBe(true);
			expect(json.preferences.sms_notifications_enabled).toBe(true);
			expect(json.preferences.sms_opted_out).toBe(false);
			expect(json.preferences.phone_verified).toBe(true);
			expect(json.preferences.timezone).toBe("America/Los_Angeles");
			expect(json.preferences.daily_digest_enabled).toBe(true);
			expect(json.preferences.daily_digest_notification_times).toEqual([480]);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
