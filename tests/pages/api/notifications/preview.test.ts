import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notifications/preview";
import { adminClient } from "../../../setup";
import { createAuthenticatedCookies, createTestUser } from "../../../utils";

const TEST_PASSWORD = "TestPassword123!";

describe("Preview Notifications Endpoint", () => {
	const hasResendCredentials = Boolean(process.env.RESEND_API_KEY);
	const hasTwilioCredentials = Boolean(
		process.env.TWILIO_ACCOUNT_SID &&
			process.env.TWILIO_AUTH_TOKEN &&
			process.env.TWILIO_PHONE_NUMBER,
	);

	beforeAll(() => {
		if (!hasResendCredentials) {
			console.warn(
				"Skipping email preview integration test: missing RESEND_API_KEY",
			);
		}
		if (!hasTwilioCredentials) {
			console.warn(
				"Skipping SMS preview integration test: missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER",
			);
		}
	});

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
				"/dashboard?error=invalid_form",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=preview_email_disabled (302) when email notifications are disabled", async () => {
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
				"/dashboard?error=preview_email_disabled",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=preview_sms_disabled (302) when SMS notifications are disabled", async () => {
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
				"/dashboard?error=preview_sms_disabled",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=preview_sms_opted_out (302) when user has opted out of SMS notifications", async () => {
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
				"/dashboard?error=preview_sms_opted_out",
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
				"/dashboard?error=preview_sms_unverified",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	(hasResendCredentials ? it : it.skip)(
		"redirects to /dashboard?success=preview_email_sent (302) when user has valid email fields",
		async () => {
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
					"/dashboard?success=preview_email_sent",
				);
			} finally {
				await adminClient.auth.admin.deleteUser(id);
			}
		},
	);

	(hasTwilioCredentials ? it : it.skip)(
		"redirects to /dashboard?success=preview_sms_sent (302) when user has valid SMS fields",
		async () => {
			const { id, email } = await createTestUser({
				email: `test-${randomUUID()}@resend.dev`,
				confirmed: true,
				smsNotificationsEnabled: true,
				trackedStocks: ["AAPL"],
			});

			try {
				// Use a unique phone number to avoid duplicate key constraint
				// Twilio test credentials accept any number, so we can use a timestamp-based one
				const uniquePhoneNumber = `500555${String(Date.now()).slice(-4)}`;
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
					"/dashboard?success=preview_sms_sent",
				);
			} finally {
				await adminClient.auth.admin.deleteUser(id);
			}
		},
	);
});
