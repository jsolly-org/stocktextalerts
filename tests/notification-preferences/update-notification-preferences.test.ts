import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_DIGEST_TIME_MINUTES } from "../../src/lib/constants";
import { POST } from "../../src/pages/api/notification-preferences/update";
import { TEST_PASSWORD } from "../constants";
import { registerTestUserForCleanup } from "../setup";
import {
	adminClient,
	createAuthenticatedCookies,
	createTestUser,
} from "../shared-utils";

describe("A signed-in user updates their notification channels.", () => {
	it("When the user enables their first notification channel, daily digests are enabled and scheduled at the default time.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			dailyDigestEnabled: false,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("sms_notifications_enabled", "false");

		const request = new Request(
			"http://localhost/api/notification-preferences/update",
			{
				method: "POST",
				body: formData,
				headers: { Accept: "application/json" },
			},
		);

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				daily_digest_enabled: boolean;
				daily_digest_notification_times: number[] | null;
				next_send_at: string | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.notificationPreferences.daily_digest_enabled).toBe(true);
		expect(
			payload.notificationPreferences.daily_digest_notification_times,
		).toEqual([DEFAULT_DAILY_DIGEST_TIME_MINUTES]);
		expect(payload.notificationPreferences.next_send_at).toBeTruthy();

		const { data: updatedUser } = await adminClient
			.from("users")
			.select(
				"daily_digest_enabled,daily_digest_notification_times,next_send_at",
			)
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.daily_digest_enabled).toBe(true);
		expect(updatedUser.daily_digest_notification_times).toEqual([
			DEFAULT_DAILY_DIGEST_TIME_MINUTES,
		]);
		expect(updatedUser.next_send_at).toBeTruthy();
	});

	it("The user updates the daily digest time to a new hour.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("sms_notifications_enabled", "false");
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["12:00"]),
		);

		const request = new Request(
			"http://localhost/api/notification-preferences/update",
			{
				method: "POST",
				body: formData,
			},
		);

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

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
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["10:00", "08:00", "10:00", "11:00"]),
		);

		const request = new Request(
			"http://localhost/api/notification-preferences/update",
			{
				method: "POST",
				body: formData,
			},
		);

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

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
			password: TEST_PASSWORD,
			confirmed: true,
			dailyDigestEnabled: true,
			dailyDigestNotificationTimes: [480],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("daily_digest_notification_times", "[]");

		const request = new Request(
			"http://localhost/api/notification-preferences/update",
			{
				method: "POST",
				body: formData,
				headers: { Accept: "application/json" },
			},
		);

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			notificationPreferences: {
				daily_digest_notification_times: number[] | null;
				next_send_at: string | null;
			};
		};

		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(
			payload.notificationPreferences.daily_digest_notification_times,
		).toBeNull();
		expect(payload.notificationPreferences.next_send_at).toBeNull();
	});
});
