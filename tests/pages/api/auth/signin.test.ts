import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/auth/signin";
import { adminClient } from "../../../setup";
import { createTestUser } from "../../../utils";

describe("POST /api/auth/signin", () => {
	it("should successfully sign in with correct email and password", async () => {
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
				}),
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
			expect(response.headers.get("Location")).toBe("/dashboard");
			expect(cookies.get("sb-access-token")).toBeDefined();
			expect(cookies.get("sb-refresh-token")).toBeDefined();
		} finally {
			await adminClient.auth.admin.deleteUser(testUser.id);
		}
	});

	it("should return invalid_credentials when email does not exist", async () => {
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
		expect(location).toContain("/signin?error=invalid_credentials");
		expect(location).toContain(encodeURIComponent(nonExistentEmail));
	});

	it("should return invalid_credentials when password is incorrect", async () => {
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
			expect(location).toContain("/signin?error=invalid_credentials");
			expect(location).toContain(encodeURIComponent(testUser.email));
		} finally {
			await adminClient.auth.admin.deleteUser(testUser.id);
		}
	});
});
