import { randomInt, randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/notifications/preview";
import { adminClient } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

const TEST_PASSWORD = "TestPassword123!";

describe("Preview Notifications Endpoint", () => {
	const toAstroCookies = (
		cookies: Map<string, string>,
	): APIContext["cookies"] =>
		({
			get: (name: string) => {
				const value = cookies.get(name);
				return value ? { value } : undefined;
			},
			set: () => {},
		}) as unknown as APIContext["cookies"];

	const toRedirect = (url: string) =>
		new Response(null, {
			status: 302,
			headers: { Location: url },
		});

	const buildRequest = (type?: string) => {
		const formData = new FormData();
		if (type) {
			formData.append("type", type);
		}
		return new Request("http://localhost/api/notifications/preview", {
			method: "POST",
			body: formData,
		});
	};

	it("redirects to /signin?error=unauthorized (302) when user is not authenticated", async () => {
		const request = buildRequest("email");

		const response = await POST({
			request,
			cookies: toAstroCookies(new Map()),
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
	});

	it("redirects to /dashboard?error=invalid_form (302) when notification type is invalid", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
		});
		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("invalid");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=invalid_form#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=email_notifications_disabled (302) when email notifications are disabled", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: false,
		});

		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("email");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=email_notifications_disabled#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=sms_notifications_disabled (302) when SMS notifications are disabled", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			smsNotificationsEnabled: false,
		});

		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("sms");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=sms_notifications_disabled#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=sms_opted_out (302) when user has opted out of SMS notifications", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			smsNotificationsEnabled: true,
		});

		try {
			const { error: updateError } = await adminClient
				.from("users")
				.update({ sms_opted_out: true })
				.eq("id", id);

			if (updateError) {
				throw new Error(`Failed to set up test user: ${updateError.message}`);
			}

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("sms");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=sms_opted_out#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=preview_sms_unverified (302) when phone number is not verified", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			smsNotificationsEnabled: true,
		});

		try {
			const { error: updateError } = await adminClient
				.from("users")
				.update({
					phone_country_code: "+1",
					phone_number: "5005550006",
					phone_verified: false,
					sms_opted_out: false,
				})
				.eq("id", id);

			if (updateError) {
				throw new Error(`Failed to set up test user: ${updateError.message}`);
			}

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("sms");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=preview_sms_unverified#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?success=preview_email_sent (302) when user has valid email fields", async () => {
		const { id, email } = await createTestUser({
			email:
				process.env.TEST_EMAIL_RECIPIENT || `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("email");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?success=preview_email_sent#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?success=preview_sms_sent (302) when user has valid SMS fields", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			smsNotificationsEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			// Use a unique phone number to avoid duplicate key constraint
			// Twilio test credentials accept any number, so we use random digits for uniqueness
			const uniquePhoneNumber = `50${String(randomInt(0, 10 ** 8)).padStart(
				8,
				"0",
			)}`;
			const { error: updateError } = await adminClient
				.from("users")
				.update({
					phone_country_code: "+1",
					phone_number: uniquePhoneNumber,
					phone_verified: true,
					sms_opted_out: false,
				})
				.eq("id", id);

			if (updateError) {
				throw new Error(
					`Failed to set up test user phone: ${updateError.message}`,
				);
			}

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const request = buildRequest("sms");

			const response = await POST({
				request,
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?success=preview_sms_sent#preview-notifications",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});
});
