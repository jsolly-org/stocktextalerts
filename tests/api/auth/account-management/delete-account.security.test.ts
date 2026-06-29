import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/auth/account-management/delete-account";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("Delete account requires authentication.", () => {
	it("An unauthenticated request is redirected to the home page.", async () => {
		const request = new Request("http://localhost/api/auth/account-management/delete-account", {
			method: "POST",
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");
	});
});

describe("Delete account endpoint enforces rate limiting.", () => {
	it("When rate limit is exceeded, the request is redirected with rate_limit error.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const attempts =
			Number.parseInt(process.env.DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS ?? "5", 10) || 5;

		await adminClient.from("rate_limit_log").insert(
			Array.from({ length: attempts }, () => ({
				user_id: testUser.id,
				endpoint: "delete_account",
			})),
		);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const request = new Request("http://localhost/api/auth/account-management/delete-account", {
			method: "POST",
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/profile?error=rate_limit");
		expect(location).toContain("minutes=");
	});
});
