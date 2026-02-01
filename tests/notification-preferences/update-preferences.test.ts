import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/preferences/update";
import { registerTestUserForCleanup } from "../setup";
import {
	adminClient,
	createAuthenticatedCookies,
	createTestUser,
} from "../shared-utils";

describe("A signed-in user updates their notification preferences.", () => {
	it("The user updates the daily digest time to a new hour.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("sms_notifications_enabled", "false");
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["12:00"]),
		);

		const request = new Request("http://localhost/api/preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.daily_digest_notification_times).toEqual([720]);
	});

	it("Submitted digest times are cleaned up and stored in order.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["10:00", "08:00", "10:00", "11:00"]),
		);

		const request = new Request("http://localhost/api/preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(200);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.daily_digest_notification_times).toEqual([
			480, 600, 660,
		]);
	});

	it("When all digest times are removed, daily digest scheduling is cleared.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			dailyDigestEnabled: true,
			dailyDigestNotificationTimes: [480],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("daily_digest_notification_times", "[]");

		const request = new Request("http://localhost/api/preferences/update", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			preferences: {
				daily_digest_notification_times: number[] | null;
				next_send_at: string | null;
			};
		};

		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.preferences.daily_digest_notification_times).toBeNull();
		expect(payload.preferences.next_send_at).toBeNull();
	});
});
