import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/preferences/timezone";
import { adminClient } from "../setup";
import {
	cleanupTestUser,
	createAuthenticatedCookies,
	createTestUser,
} from "../utils";

describe("POST /api/preferences/timezone", () => {
	const TEST_PASSWORD = "TestPassword123!";

	it("updates the current user's timezone", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);

			const formData = new FormData();
			formData.append("timezone", "Etc/UTC");

			const request = new Request("http://localhost/api/preferences/timezone", {
				method: "POST",
				body: formData,
			});

			const response = await POST({
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
			expect(json.message).toBe("timezone_updated");
			expect(json.preferences.timezone).toBe("Etc/UTC");

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("timezone")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.timezone).toBe("Etc/UTC");
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});

	it("returns JSON response with preferences", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-json-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		try {
			const cookies = await createAuthenticatedCookies(
				testUser.email,
				TEST_PASSWORD,
			);

			const formData = new FormData();
			formData.append("timezone", "Etc/UTC");

			const request = new Request("http://localhost/api/preferences/timezone", {
				method: "POST",
				body: formData,
				headers: { Accept: "application/json" },
			});

			const response = await POST({
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
			expect(json.message).toBe("timezone_updated");
			expect(json.preferences).toBeDefined();
			expect(json.preferences.timezone).toBe("Etc/UTC");
			expect(json.preferences).toHaveProperty("next_send_at");

			const { data: updatedUser, error } = await adminClient
				.from("users")
				.select("timezone")
				.eq("id", testUser.id)
				.single();

			expect(error).toBeNull();
			expect(updatedUser).not.toBeNull();
			expect(updatedUser.timezone).toBe("Etc/UTC");
		} finally {
			await cleanupTestUser(testUser.id);
		}
	});
});
