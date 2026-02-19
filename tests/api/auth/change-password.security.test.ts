import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/change-password";
import { NEW_PASSWORD } from "../../helpers/constants";
import { toRedirect } from "../../helpers/request-helpers";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Password change endpoint enforces authentication, form validation, and rate limiting.", () => {
	it("Unauthenticated requests are redirected to sign-in.", async () => {
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

describe("Password change endpoint enforces rate limiting.", () => {
	it("When rate limit is exceeded, the request is redirected with rate_limit error.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const attempts =
			Number.parseInt(
				process.env.CHANGE_PASSWORD_RATE_LIMIT_ATTEMPTS ?? "5",
				10,
			) || 5;

		await adminClient.from("rate_limit_log").insert(
			Array.from({ length: attempts }, () => ({
				user_id: testUser.id,
				endpoint: "change_password",
			})),
		);

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
		const location = response.headers.get("Location");
		expect(location).toContain("/profile?error=rate_limit");
		expect(location).toContain("minutes=");
	});
});
