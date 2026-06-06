import { beforeAll, describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../helpers/constants";
import { getHttpTestBase } from "../helpers/http/base-url";
import { locationPath, postForm } from "../helpers/http/client";
import { createTestEmail, createTestUser } from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

describe("Auth form posts over HTTP", () => {
	let baseUrl = "";

	beforeAll(async () => {
		baseUrl = await getHttpTestBase();
	}, 130_000);

	it("sign-in with valid credentials redirects to the dashboard and sets session cookies", async () => {
		const testUser = await createTestUser({
			email: createTestEmail("http-signin"),
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { response, cookies } = await postForm(baseUrl, {
			path: "/api/auth/signin",
			fields: {
				email: testUser.email,
				password: TEST_PASSWORD,
			},
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toBe("/dashboard");
		expect(cookies.get("sb-access-token")).toBeTruthy();
		expect(cookies.get("sb-refresh-token")).toBeTruthy();
	});

	it("register with a weak password redirects with a validation error", async () => {
		const email = createTestEmail("http-register-weak");

		const { response } = await postForm(baseUrl, {
			path: "/api/auth/email/register",
			fields: {
				email,
				password: "short",
				timezone: "America/New_York",
			},
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toContain("/auth/register?error=weak_password");
	});

	it("forgot-password request redirects with success for any email", async () => {
		const email = createTestEmail("http-forgot");

		const { response } = await postForm(baseUrl, {
			path: "/api/auth/email/forgot-password",
			fields: { email },
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toBe("/auth/forgot?success=true");
	});

	it("update-password with an invalid token redirects with an error", async () => {
		const { response } = await postForm(baseUrl, {
			path: "/api/auth/update-password",
			fields: {
				password: TEST_PASSWORD,
				token_hash: "invalid-token-hash",
			},
		});

		expect(response.status).toBeGreaterThanOrEqual(300);
		expect(response.status).toBeLessThan(400);
		expect(locationPath(response)).toContain("/auth/recover?error=");
	});
});
