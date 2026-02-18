import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/change-password";
import { NEW_PASSWORD } from "../../helpers/constants";
import { toRedirect } from "../../helpers/request-helpers";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user changes their password from profile.", () => {
	it("A valid password update redirects with success and allows sign-in with the new password.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			originalPassword,
		);

		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: NEW_PASSWORD,
				confirm: NEW_PASSWORD,
			}),
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const value = cookies.get(name);
					return value ? { value } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/profile?success=password_changed");

		const newPasswordCookies = await createAuthenticatedCookies(
			testUser.email,
			NEW_PASSWORD,
		);
		expect(newPasswordCookies.get("sb-access-token")).toBeTruthy();
		expect(newPasswordCookies.get("sb-refresh-token")).toBeTruthy();
	});

	it("Mismatched passwords are rejected.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			originalPassword,
		);

		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: NEW_PASSWORD,
				confirm: "DifferentPassword123!",
			}),
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const value = cookies.get(name);
					return value ? { value } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/profile?error=password_mismatch",
		);
	});

	it("Weak passwords are rejected.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			originalPassword,
		);

		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "short",
				confirm: "short",
			}),
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const value = cookies.get(name);
					return value ? { value } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/profile?error=weak_password");
	});
});
