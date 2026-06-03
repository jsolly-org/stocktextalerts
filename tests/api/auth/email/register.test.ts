import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEZONE } from "../../../../src/lib/constants";
import type { EmailSender } from "../../../../src/lib/messaging/email/utils";
import { POST } from "../../../../src/pages/api/auth/email/register";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient } from "../../../helpers/test-env";
import { cleanupTestUser } from "../../../helpers/test-user";
import { expectConsoleError } from "../../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "mock-admin-registration-email",
	})),
);

vi.mock("../../../../src/lib/constants", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/constants")>();
	return { ...actual, REGISTRATION_ENABLED: true };
});

vi.mock("../../../../src/lib/messaging/email/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/messaging/email/utils")>();
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

function buildRegistrationPayload(
	overrides: Partial<{
		email: string;
		password: string;
		confirm: string;
		timezone: string;
	}> = {},
) {
	return {
		email: `test-${randomUUID()}@example.com`,
		password: TEST_PASSWORD,
		confirm: TEST_PASSWORD,
		timezone: "America/New_York",
		...overrides,
	};
}

describe("A visitor registers for a new account with email and password.", () => {
	beforeEach(() => {
		mockEmailSender.mockClear();
		vi.stubEnv("EMAIL_FROM", "admin@example.com");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("The account is created, stored with the chosen timezone, and the user is redirected to the unconfirmed email page.", async () => {
		const payload = buildRegistrationPayload();
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST(createApiContext({ request }));

			// Verify redirect to unconfirmed email page
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(encodeURIComponent(payload.email));

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
			expect(user.approved_at).toBeNull();
			expect(mockEmailSender).toHaveBeenCalledOnce();
			expect(mockEmailSender).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "admin@example.com",
					subject: "New StockTextAlerts registration pending approval",
					body: expect.stringContaining(payload.email),
					userId: user.id,
				}),
			);

			// Verify user was created in auth
			const { data: authUserData, error: authError } = await adminClient.auth.admin.getUserById(
				user.id,
			);
			expect(authError).toBeNull();
			if (!authUserData?.user) throw new Error("No auth user found");
			expect(authUserData.user.email).toBe(payload.email);
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});

	it("When the admin notification email fails, registration still completes.", async () => {
		expectConsoleError("Failed to send registration admin email");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SMTP down",
			errorCode: "smtp_error",
		});

		const payload = buildRegistrationPayload();
		let userId: string | undefined;

		try {
			const response = await POST(
				createApiContext({
					request: new Request("http://localhost/api/auth/email/register", {
						method: "POST",
						body: new URLSearchParams(payload),
					}),
				}),
			);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");

			const { data: users, error: usersError } = await adminClient
				.from("users")
				.select("id, approved_at")
				.eq("email", payload.email);
			expect(usersError).toBeNull();
			expect(users).toHaveLength(1);
			userId = users?.[0]?.id;
			expect(users?.[0]?.approved_at).toBeNull();
		} finally {
			if (userId) {
				await cleanupTestUser(userId);
			}
		}
	});

	it("When the detected timezone is invalid, the account is created with the default timezone.", async () => {
		const payload = buildRegistrationPayload({
			email: `test-fallback-${randomUUID()}@example.com`,
			timezone: "Fake/Zone",
		});
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST(createApiContext({ request }));

			// Verify redirect to unconfirmed email page
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(encodeURIComponent(payload.email));

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
		const payload = buildRegistrationPayload({
			email: `test-chosen-${randomUUID()}@example.com`,
			timezone: chosenTimezone,
		});
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST(createApiContext({ request }));

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("/auth/unconfirmed");
			expect(response.headers.get("Location")).toContain(encodeURIComponent(payload.email));

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
		const payload = buildRegistrationPayload({
			email: `test-verify-${randomUUID()}@example.com`,
		});
		let userId: string | undefined;

		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams(payload),
		});

		try {
			const response = await POST(createApiContext({ request }));

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
			const { data: authUserData, error: authError } = await adminClient.auth.admin.getUserById(
				user.id,
			);
			expect(authError).toBeNull();
			if (!authUserData?.user) throw new Error("No auth user found");

			// Verify email is NOT confirmed initially
			expect(authUserData.user.email_confirmed_at).toBeUndefined();

			// Simulate email verification by updating the user's email_confirmed_at
			const { data: updatedUserData, error: updateError } =
				await adminClient.auth.admin.updateUserById(user.id, {
					email_confirm: true,
				});
			expect(updateError).toBeNull();
			if (!updatedUserData?.user) throw new Error("Failed to update user");

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
