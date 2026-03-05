import { describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/auth/delete-account";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../../helpers/test-user";

describe("A signed-in user deletes their account from the profile page.", () => {
	it("The account is removed, auth cookies are cleared, and the user is redirected home with a success message.", async () => {
		const testUser = await createTestUser({
			password: TEST_PASSWORD,
			confirmed: true,
		});
		let cleanupNeeded = true;

		try {
			const authCookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);
			const deleteSpy = vi.fn();

			const request = new Request("http://localhost/api/auth/delete-account", {
				method: "POST",
			});

			const response = await POST(
				createApiContext({
					request,
					cookies: authCookies,
					onDeleteCookie: deleteSpy,
				}),
			);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/?success=account_deleted",
			);
			expect(deleteSpy).toHaveBeenCalled();

			const { data: dbUser, error: dbError } = await adminClient
				.from("users")
				.select("id")
				.eq("id", testUser.id)
				.maybeSingle();
			expect(dbError).toBeNull();
			expect(dbUser).toBeNull();

			const { data: authUserData, error: authError } =
				await adminClient.auth.admin.getUserById(testUser.id);
			if (authError) {
				expect(authError.status).toBe(404);
			} else {
				expect(authUserData.user).toBeNull();
			}

			cleanupNeeded = false;
		} finally {
			if (cleanupNeeded) {
				await cleanupTestUser(testUser.id);
			}
		}
	});
});
