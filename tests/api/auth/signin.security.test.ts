import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/signin";
import {
	cleanupTestUser,
	createTestUser,
	toRedirect,
} from "../../helpers/shared-utils";

describe("A user signs in with an email and password.", () => {
	it("If the redirect is unsafe, the user is redirected to the default dashboard.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const request = new Request("http://localhost/api/auth/signin", {
				method: "POST",
				body: new URLSearchParams({
					email: testUser.email,
					password: "TestPassword123!",
					captcha_token: "test-captcha-token",
					redirect: "https://example.com/evil",
				}),
			});

			const response = await POST({
				request,
				cookies: {
					set: () => {},
				},
				redirect: toRedirect,
			} as unknown as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe("/dashboard");
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If the form is incomplete, the user sees a validation error.", async () => {
		const request = new Request("http://localhost/api/auth/signin", {
			method: "POST",
			body: new URLSearchParams({
				// Email provided but empty; password missing
				email: "",
				captcha_token: "test-captcha-token",
			}),
		});

		const response = await POST({
			request,
			cookies: {
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain(
			"/auth/signin?error=invalid_form",
		);
	});
});
