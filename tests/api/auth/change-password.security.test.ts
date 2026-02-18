import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/change-password";
import { toRedirect } from "../../helpers/request-helpers";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Password change endpoint enforces authentication and form validation.", () => {
	it("Unauthenticated requests are redirected to sign-in.", async () => {
		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "NewPassword123!",
				confirm: "NewPassword123!",
			}),
		});

		const response = await POST({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?error=unauthorized",
		);
	});

	it("Authenticated requests with missing fields are rejected as invalid form.", async () => {
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
				password: "",
				confirm: "",
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
			"/profile?error=invalid_form",
		);
	});
});
