import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/preferences";
import { adminClient } from "../../../setup";
import { createAuthenticatedCookies, createTestUser } from "../../../utils";

describe("POST /api/preferences", () => {
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
		formData.append("daily_digest_notification_time", "08:00");
		formData.append("tracked_stocks", JSON.stringify([]));

		const request = new Request("http://localhost/api/preferences", {
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
			redirect: (url: string) => {
				return new Response(null, {
					status: 302,
					headers: { Location: url },
				});
			},
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/dashboard?success=settings_updated",
		);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.email_notifications_enabled).toBe(true);
		expect(updatedUser.sms_notifications_enabled).toBe(false);
		expect(updatedUser.timezone).toBe("America/Los_Angeles");
		expect(updatedUser.daily_digest_notification_time).toBe(480);
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
		formData.append("daily_digest_notification_time", "12:00");
		formData.append("tracked_stocks", JSON.stringify([]));

		const request = new Request("http://localhost/api/preferences", {
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
			redirect: (url: string) => {
				return new Response(null, {
					status: 302,
					headers: { Location: url },
				});
			},
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/dashboard?success=settings_updated",
		);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("*")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser.daily_digest_notification_time).toBe(720);
	});
});
