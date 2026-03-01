import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE } from "../../../../src/lib/constants";
import { POST } from "../../../../src/pages/api/auth/email/register";
import { toRedirect } from "../../../helpers/request-helpers";
import { adminClient } from "../../../helpers/test-env";
import { cleanupTestUser } from "../../../helpers/test-user";

describe("A visitor registers for a new account with email and password.", () => {
	it("The account is created, stored with the chosen timezone, and the user is redirected to the unconfirmed email page.", async () => {
		const payload = {
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			timezone: "America/New_York",
		};
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST({
				request,
				redirect: toRedirect,
			} as APIContext);

			// Verify redirect to unconfirmed email page
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(
				encodeURIComponent(payload.email),
			);

			// Verify only one user was created
			const { data: users, error: usersError } = await adminClient
				.from("users")
				.select("*")
				.eq("email", payload.email);
			expect(usersError).toBeNull();

			if (!users) throw new Error("No users found");
			expect(users).toHaveLength(1);

			// Verify user data matches payload
			const user = users[0];
			userId = user.id;
			expect(user.email).toBe(payload.email);
			expect(user.timezone).toBe(payload.timezone);

			// Verify user was created in auth
			const { data: authUserData, error: authError } =
				await adminClient.auth.admin.getUserById(user.id);
			expect(authError).toBeNull();
			if (!authUserData || !authUserData.user)
				throw new Error("No auth user found");
			expect(authUserData.user.email).toBe(payload.email);
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});

	it("When the detected timezone is invalid, the account is created with the default timezone.", async () => {
		const payload = {
			email: `test-fallback-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			timezone: "Fake/Zone",
		};
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST({
				request,
				redirect: toRedirect,
			} as APIContext);

			// Verify redirect to unconfirmed email page
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(
				encodeURIComponent(payload.email),
			);

			// Verify user was created with fallback timezone
			const { data: users, error: usersError } = await adminClient
				.from("users")
				.select("*")
				.eq("email", payload.email);
			expect(usersError).toBeNull();
			if (!users) throw new Error("No users found");
			expect(users).toHaveLength(1);

			const user = users[0];
			userId = user.id;
			expect(user.email).toBe(payload.email);
			expect(user.timezone).toBe(DEFAULT_TIMEZONE);
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});

	it("User's timezone is detected, but they choose a different one. It is saved based on their choice.", async () => {
		const chosenTimezone = "America/Chicago";
		const payload = {
			email: `test-chosen-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			timezone: chosenTimezone,
		};
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST({
				request,
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(
				encodeURIComponent(payload.email),
			);

			const { data: users, error: usersError } = await adminClient
				.from("users")
				.select("*")
				.eq("email", payload.email);
			expect(usersError).toBeNull();
			if (!users) throw new Error("No users found");
			expect(users).toHaveLength(1);

			const user = users[0];
			userId = user.id;
			expect(user.email).toBe(payload.email);
			expect(user.timezone).toBe(chosenTimezone);
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});

	it("After registering, the email remains unverified until confirmation is completed.", async () => {
		const payload = {
			email: `test-verify-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			timezone: "America/New_York",
		};
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST({
				request,
				redirect: toRedirect,
			} as APIContext);

			// Verify registration succeeded
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");

			// Get the user from the database
			const { data: users, error: usersError } = await adminClient
				.from("users")
				.select("*")
				.eq("email", payload.email);
			expect(usersError).toBeNull();
			if (!users || users.length === 0) throw new Error("No users found");
			const user = users[0];
			userId = user.id;

			// Verify user was created in auth
			const { data: authUserData, error: authError } =
				await adminClient.auth.admin.getUserById(user.id);
			expect(authError).toBeNull();
			if (!authUserData || !authUserData.user)
				throw new Error("No auth user found");

			// Verify email is NOT confirmed initially
			expect(authUserData.user.email_confirmed_at).toBeUndefined();

			// Simulate email verification by updating the user's email_confirmed_at
			const { data: updatedUserData, error: updateError } =
				await adminClient.auth.admin.updateUserById(user.id, {
					email_confirm: true,
				});
			expect(updateError).toBeNull();
			if (!updatedUserData || !updatedUserData.user)
				throw new Error("Failed to update user");

			// Verify email is now confirmed
			const confirmedAt = updatedUserData.user.email_confirmed_at;
			expect(confirmedAt).toBeTruthy();
			expect(typeof confirmedAt).toBe("string");
			if (!confirmedAt) {
				throw new Error("Missing email_confirmed_at");
			}
			expect(DateTime.fromISO(confirmedAt).toMillis()).not.toBeNaN();
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});
});
