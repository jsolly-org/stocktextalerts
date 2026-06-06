import { beforeAll, describe, expect, it } from "vitest";
import { NEW_PASSWORD, TEST_PASSWORD } from "../helpers/constants";
import { getHttpTestBase } from "../helpers/http/base-url";
import { locationPath, postForm } from "../helpers/http/client";
import { createTestEmail, createTestUser } from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

describe("Profile password form posts over HTTP", () => {
	let baseUrl = "";

	beforeAll(async () => {
		baseUrl = await getHttpTestBase();
	}, 130_000);

	it("change-password without a session redirects to sign-in", async () => {
		const { response } = await postForm(baseUrl, {
			path: "/api/auth/change-password",
			fields: { password: NEW_PASSWORD },
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toBe("/auth/signin?error=unauthorized");
	});

	it("change-password with a weak password redirects with weak_password", async () => {
		const testUser = await createTestUser({
			email: createTestEmail("http-profile-weak"),
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(testUser.id);

		const signIn = await postForm(baseUrl, {
			path: "/api/auth/signin",
			fields: {
				email: testUser.email,
				password: TEST_PASSWORD,
			},
		});
		expect(signIn.response.status).toBe(302);

		const { response } = await postForm(baseUrl, {
			path: "/api/auth/change-password",
			fields: { password: "short" },
			cookies: signIn.cookies,
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toBe("/profile?error=weak_password");
	});

	it("change-password with a valid session updates the password", async () => {
		const testUser = await createTestUser({
			email: createTestEmail("http-profile-ok"),
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		registerTestUserForCleanup(testUser.id);

		const signIn = await postForm(baseUrl, {
			path: "/api/auth/signin",
			fields: {
				email: testUser.email,
				password: TEST_PASSWORD,
			},
		});
		expect(signIn.response.status).toBe(302);

		const { response } = await postForm(baseUrl, {
			path: "/api/auth/change-password",
			fields: { password: NEW_PASSWORD },
			cookies: signIn.cookies,
		});

		expect(response.status).toBe(302);
		expect(locationPath(response)).toBe("/profile?success=password_changed");

		const reSignIn = await postForm(baseUrl, {
			path: "/api/auth/signin",
			fields: {
				email: testUser.email,
				password: NEW_PASSWORD,
			},
		});
		expect(reSignIn.response.status).toBe(302);
		expect(locationPath(reSignIn.response)).toBe("/dashboard");
	});
});
