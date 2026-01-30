import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/preferences/update";
import { adminClient } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

describe("POST /api/preferences/update", () => {
	it("should successfully update user preferences", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("sms_notifications_enabled", "false");
		formData.append("timezone", "America/Los_Angeles");
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["08:00"]),
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

		expect(updatedUser.email_notifications_enabled).toBe(true);
		expect(updatedUser.sms_notifications_enabled).toBe(false);
		expect(updatedUser.timezone).toBe("America/Los_Angeles");
		expect(updatedUser.daily_digest_notification_times).toEqual([480]);
	});

	it("should successfully update preferences with a different daily digest hour", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

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

	it("should sort and de-duplicate daily digest times", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

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

	it("should return JSON when Accept header requests it", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");
		formData.append("sms_notifications_enabled", "false");
		formData.append("timezone", "America/Los_Angeles");
		formData.append("daily_digest_enabled", "true");
		formData.append(
			"daily_digest_notification_times",
			JSON.stringify(["08:00"]),
		);

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
				email_notifications_enabled: boolean;
				sms_notifications_enabled: boolean;
				timezone: string;
				daily_digest_enabled: boolean;
				daily_digest_notification_times: number[] | null;
				next_send_at: string | null;
			};
		};

		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.preferences.email_notifications_enabled).toBe(true);
		expect(payload.preferences.sms_notifications_enabled).toBe(false);
		expect(payload.preferences.timezone).toBe("America/Los_Angeles");
		expect(payload.preferences.daily_digest_enabled).toBe(true);
		expect(payload.preferences.daily_digest_notification_times).toEqual([480]);
	});

	it("should clear daily digest times when empty array submitted", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			dailyDigestEnabled: true,
			dailyDigestNotificationTimes: [480],
		});

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
