import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/update-password";
import { createApiContext } from "../../helpers/api-context";
import { NEW_PASSWORD } from "../../helpers/constants";
import { adminClient } from "../../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../../helpers/test-user";

describe("A user resets their password from the recovery flow.", () => {
	it("With a valid token and password, the user is redirected to the sign-in page.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "OldPassword123!",
			confirmed: true,
		});

		try {
			const { data: linkData, error: linkError } =
				await adminClient.auth.admin.generateLink({
					type: "recovery",
					email: testUser.email,
				});

			if (linkError || !linkData?.properties?.hashed_token) {
				throw new Error(
					`Failed to generate recovery link: ${linkError?.message ?? "missing hashed_token"}`,
				);
			}

			const tokenHash = linkData.properties.hashed_token;

			const request = new Request("http://localhost/api/auth/update-password", {
				method: "POST",
				body: new URLSearchParams({
					password: NEW_PASSWORD,
					confirm: NEW_PASSWORD,
					token_hash: tokenHash,
				}),
			});

			const response = await POST(createApiContext({ request }));

			expect(response.status).toBe(303);
			expect(response.headers.get("Location")).toBe(
				"/auth/signin?success=password_reset",
			);

			const { error: signInError } = await adminClient.auth.signInWithPassword({
				email: testUser.email,
				password: NEW_PASSWORD,
			});
			expect(signInError).toBeNull();
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("If the passwords do not match, the user sees a mismatch error.", async () => {
		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "Mismatch123!",
				confirm: "Different123!",
				token_hash: "token_hash_value",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("error=password_mismatch");
		expect(location).toContain("token_hash=token_hash_value");
	});

	it("If the new password is too short, the user sees a strength error.", async () => {
		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "short",
				confirm: "short",
				token_hash: "token_hash_value",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("error=weak_password");
		expect(location).toContain("type=recovery");
		expect(location).toContain("token_hash=token_hash_value");
	});
});
