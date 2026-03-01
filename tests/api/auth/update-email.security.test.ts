import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/update-email";
import { TEST_PASSWORD } from "../../helpers/constants";
import { toRedirect } from "../../helpers/request-helpers";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Update email requires authentication.", () => {
	it("An unauthenticated request is redirected to sign-in with an error.", async () => {
		const request = new Request("http://localhost/api/auth/update-email", {
			method: "POST",
			body: new URLSearchParams({ email: "new@example.com" }),
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
});

describe("Update email endpoint enforces rate limiting.", () => {
	it("When rate limit is exceeded, the request is redirected with rate_limit error.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const attempts =
			Number.parseInt(
				process.env.CHANGE_EMAIL_RATE_LIMIT_ATTEMPTS ?? "5",
				10,
			) || 5;

		const { error: insertError } = await adminClient
			.from("rate_limit_log")
			.insert(
				Array.from({ length: attempts }, () => ({
					user_id: testUser.id,
					endpoint: "change_email",
				})),
			);
		if (insertError) {
			throw new Error(`Failed to seed rate_limit_log: ${insertError.message}`);
		}

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const request = new Request("http://localhost/api/auth/update-email", {
			method: "POST",
			body: new URLSearchParams({ email: `new-${randomUUID()}@example.com` }),
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
