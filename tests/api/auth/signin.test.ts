import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/signin";
import { cleanupTestUser, createTestUser } from "../../helpers/shared-utils";

async function signInAndAssertRedirect(
	email: string,
	password: string,
	redirectParam: string | undefined,
	expectedLocation: string,
): Promise<void> {
	const body: Record<string, string> = {
		email,
		password,
		captcha_token: "test-captcha-token",
	};
	if (redirectParam !== undefined) {
		body.redirect = redirectParam;
	}

	const request = new Request("http://localhost/api/auth/signin", {
		method: "POST",
		body: new URLSearchParams(body),
	});

	const cookies = new Map<string, string>();
	const response = await POST({
		request,
		cookies: {
			set: (name: string, value: string) => {
				cookies.set(name, value);
			},
		},
		redirect: (url: string) => {
			return new Response(null, {
				status: 302,
				headers: { Location: url },
			});
		},
	} as unknown as APIContext);

	expect(response.status).toBe(302);
	expect(response.headers.get("Location")).toBe(expectedLocation);
	expect(cookies.get("sb-access-token")).toBeDefined();
	expect(cookies.get("sb-refresh-token")).toBeDefined();
}

describe("Sign in with correct email and password.", () => {
	it("User signs in from home route and is sent to /dashboard.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			await signInAndAssertRedirect(
				testUser.email,
				"TestPassword123!",
				undefined,
				"/dashboard",
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("Unauthenticated user attempts /dashboard, is prompted to sign in, then is redirected to /dashboard.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			await signInAndAssertRedirect(
				testUser.email,
				"TestPassword123!",
				"/dashboard",
				"/dashboard",
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("Unauthenticated user attempts /profile, is prompted to sign in, then is redirected to /profile.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
		});

		try {
			await signInAndAssertRedirect(
				testUser.email,
				"TestPassword123!",
				"/profile",
				"/profile",
			);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});

describe("Sign in with incorrect credentials.", () => {
	it("If the email is not found, the user sees an invalid credentials message.", async () => {
		const nonExistentEmail = `nonexistent-${randomUUID()}@resend.dev`;

		const request = new Request("http://localhost/api/auth/signin", {
			method: "POST",
			body: new URLSearchParams({
				email: nonExistentEmail,
				password: "AnyPassword123!",
				captcha_token: "test-captcha-token",
			}),
		});

		const response = await POST({
			request,
			cookies: {
				set: () => {},
			},
			redirect: (url: string) => {
				return new Response(null, {
					status: 302,
					headers: { Location: url },
				});
			},
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/auth/signin?error=invalid_credentials");
		expect(location).toContain(encodeURIComponent(nonExistentEmail));
	});

	it("If the password is incorrect, the user sees an invalid credentials message.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "CorrectPassword123!",
			confirmed: true,
		});

		try {
			const request = new Request("http://localhost/api/auth/signin", {
				method: "POST",
				body: new URLSearchParams({
					email: testUser.email,
					password: "WrongPassword123!",
					captcha_token: "test-captcha-token",
				}),
			});

			const response = await POST({
				request,
				cookies: {
					set: () => {},
				},
				redirect: (url: string) => {
					return new Response(null, {
						status: 302,
						headers: { Location: url },
					});
				},
			} as unknown as APIContext);

			expect(response.status).toBe(302);
			const location = response.headers.get("Location");
			expect(location).toContain("/auth/signin?error=invalid_credentials");
			expect(location).toContain(encodeURIComponent(testUser.email));
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
