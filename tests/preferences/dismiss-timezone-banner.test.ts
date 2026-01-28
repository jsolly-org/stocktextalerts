import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST as POSTDismissBanner } from "../../src/pages/api/preferences/dismiss-timezone-banner";
import { adminClient, allowConsoleErrors } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

describe("POST /api/preferences/dismiss-timezone-banner", () => {
	const TEST_PASSWORD = "TestPassword123!";

	it("sets dismiss_timezone_mismatch_prompts to true", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		let cleanupError: Error | undefined;
		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);

			const request = new Request(
				"http://localhost/api/preferences/dismiss-timezone-banner",
				{
					method: "POST",
				},
			);

			const response = await POSTDismissBanner({
				request,
				cookies: {
					get: (name: string) => {
						const cookie = cookies.get(name);
						return cookie ? { value: cookie } : undefined;
					},
					set: () => {},
				},
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.ok).toBe(true);
			expect(json.message).toBe("timezone_banner_dismissed");

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("dismiss_timezone_mismatch_prompts")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
		} finally {
			const { error } = await adminClient
				.from("users")
				.delete()
				.eq("id", testUser.id);
			if (error) {
				cleanupError = new Error(
					`Failed to delete test user: ${error.message}`,
				);
			}
		}

		if (cleanupError) throw cleanupError;
	});

	it("returns JSON response when dismissing banner", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-json-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		let cleanupError: Error | undefined;
		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);

			const request = new Request(
				"http://localhost/api/preferences/dismiss-timezone-banner",
				{
					method: "POST",
					headers: {
						Accept: "application/json",
					},
				},
			);

			const response = await POSTDismissBanner({
				request,
				cookies: {
					get: (name: string) => {
						const cookie = cookies.get(name);
						return cookie ? { value: cookie } : undefined;
					},
					set: () => {},
				},
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json.ok).toBe(true);
			expect(json.message).toBe("timezone_banner_dismissed");

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("dismiss_timezone_mismatch_prompts")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
		} finally {
			const { error } = await adminClient
				.from("users")
				.delete()
				.eq("id", testUser.id);
			if (error) {
				cleanupError = new Error(
					`Failed to delete test user: ${error.message}`,
				);
			}
		}

		if (cleanupError) throw cleanupError;
	});

	it("returns unauthorized when user is not authenticated", async () => {
		allowConsoleErrors();

		const request = new Request(
			"http://localhost/api/preferences/dismiss-timezone-banner",
			{
				method: "POST",
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(401);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.message).toBe("unauthorized");
	});
});
