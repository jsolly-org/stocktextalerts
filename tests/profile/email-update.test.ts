import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/notification-preferences/update";
import { registerTestUserForCleanup } from "../setup";
import {
	adminClient,
	createAuthenticatedCookies,
	createTestUser,
} from "../shared-utils";

describe("A signed-in user updates their email notification preference.", () => {
	it("The user enables email notifications.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "true");

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
			.select("email_notifications_enabled")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.email_notifications_enabled).toBe(true);
	});

	it("The user disables email notifications.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			"TestPassword123!",
		);

		const formData = new FormData();
		formData.append("email_notifications_enabled", "false");

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
			.select("email_notifications_enabled")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.email_notifications_enabled).toBe(false);
	});
});
