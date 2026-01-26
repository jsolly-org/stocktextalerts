import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST as POSTDismissBanner } from "../../src/pages/api/preferences/dismiss-timezone-banner";
import { adminClient, allowConsoleErrors } from "../setup";
import { cleanupTestUser, createAuthenticatedCookies, createTestUser } from "../utils";

const toRedirect = (url: string) =>
	new Response(null, {
		status: 302,
		headers: { Location: url },
	});

describe("POST /api/preferences/dismiss-timezone-banner", () => {
	const TEST_PASSWORD = "TestPassword123!";

	it("sets dismiss_timezone_mismatch_prompts to true and redirects back", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

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
				redirect: toRedirect,
			} as unknown as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?success=timezone_banner_dismissed#notification-preferences",
			);

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("dismiss_timezone_mismatch_prompts")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("returns JSON response when Accept header includes application/json", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-json-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

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
				redirect: toRedirect,
			} as unknown as APIContext);

			expect(response.status).toBe(200);
			const json = await response.json();
			expect(json).toEqual({ ok: true });

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("dismiss_timezone_mismatch_prompts")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("redirects to /signin?error=unauthorized when user is not authenticated", async () => {
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
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
	});
});
