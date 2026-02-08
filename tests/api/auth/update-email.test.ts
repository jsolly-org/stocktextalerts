import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/update-email";
import { toRedirect } from "../../helpers/request-helpers";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../../helpers/test-user";

describe("A signed-in user requests to change their email address.", () => {
	it("A valid request triggers the email change flow and returns the user to their profile with success.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			const request = new Request("http://localhost/api/auth/update-email", {
				method: "POST",
				body: new URLSearchParams({ email: "  new@example.com " }),
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
				"/profile?success=email_change_requested",
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("Submitting the same email the user already has is rejected.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				"TestPassword123!",
			);

			const request = new Request("http://localhost/api/auth/update-email", {
				method: "POST",
				body: new URLSearchParams({ email: testUser.email }),
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
				"/profile?error=email_unchanged",
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
