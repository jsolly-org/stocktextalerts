import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/change-password";
import { createApiContext } from "../../helpers/api-context";
import { NEW_PASSWORD } from "../../helpers/constants";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user changes their password from profile.", () => {
	it("A valid password update redirects with success and allows sign-in with the new password.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, originalPassword);

		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: NEW_PASSWORD,
			}),
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/profile?success=password_changed");

		const newPasswordCookies = await createAuthenticatedCookies(testUser.email, NEW_PASSWORD);
		expect(newPasswordCookies.get("sb-access-token")).toBeTruthy();
		expect(newPasswordCookies.get("sb-refresh-token")).toBeTruthy();
	});

	it("Weak passwords are rejected.", async () => {
		const originalPassword = "TestPassword123!";
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: originalPassword,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, originalPassword);

		const request = new Request("http://localhost/api/auth/change-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "short",
			}),
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/profile?error=weak_password");
	});
});
