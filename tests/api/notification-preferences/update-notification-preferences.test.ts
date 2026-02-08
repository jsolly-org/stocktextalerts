import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES } from "../../../src/lib/constants";
import { POST } from "../../../src/pages/api/notification-preferences/update";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user updates their notification channels.", () => {
	it("When the user enables their first notification channel, scheduled updates are enabled at the default time.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			scheduledUpdatesEnabled: false,
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
				scheduled_update_times: number[] | null;
				next_send_at: string | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.notificationPreferences.scheduled_update_times).toEqual([
			DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
		]);
		expect(payload.notificationPreferences.next_send_at).toBeTruthy();

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("scheduled_update_times,next_send_at")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.scheduled_update_times).toEqual([
			DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
		]);
		expect(updatedUser.next_send_at).toBeTruthy();
	});

	it("The user updates the notification time to a new hour.", async () => {
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
		formData.append("scheduled_update_times", JSON.stringify(["12:00"]));

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

		expect(updatedUser.scheduled_update_times).toEqual([720]);
	});

	it("Submitted scheduled times are cleaned up and stored in order.", async () => {
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
			"scheduled_update_times",
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

		expect(updatedUser.scheduled_update_times).toEqual([480, 600, 660]);
	});

	it("When all notification times are removed, scheduled updates are cleared.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			scheduledUpdatesEnabled: true,
			scheduledUpdateTimes: [480],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("scheduled_update_times", "[]");

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
				scheduled_update_times: number[] | null;
				next_send_at: string | null;
			};
		};

		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.notificationPreferences.scheduled_update_times).toBeNull();
		expect(payload.notificationPreferences.next_send_at).toBeNull();
	});
});
