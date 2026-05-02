import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/signin";
import { createApiContext } from "../../helpers/api-context";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A user signs in with an email and password.", () => {
	it("If the redirect is unsafe, the user is redirected to the default dashboard.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
		});
		try {
			const request = new Request("http://localhost/api/auth/signin", {
				method: "POST",
				body: new URLSearchParams({
					email: testUser.email,
					password: "TestPassword123!",
					redirect: "https://example.com/evil",
				}),
			});

			const response = await POST(createApiContext({ request }));

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe("/dashboard");
		} finally {
			registerTestUserForCleanup(testUser.id);
		}
	});

	it("If the form is incomplete, the user sees a validation error.", async () => {
		const request = new Request("http://localhost/api/auth/signin", {
			method: "POST",
			body: new URLSearchParams({
				// Email provided but empty; password missing
				email: "",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("/auth/signin?error=invalid_form");
	});
});
