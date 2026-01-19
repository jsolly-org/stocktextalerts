import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notifications/daily-digest-now";
import { adminClient } from "../../../setup";
import { createAuthenticatedCookies, createTestUser } from "../../../utils";

const TEST_PASSWORD = "TestPassword123!";

describe("Daily Digest Now Endpoint", () => {
	const hasResendCredentials = Boolean(process.env.RESEND_API_KEY);

	beforeAll(() => {
		if (!hasResendCredentials) {
			console.warn(
				"Skipping daily digest now integration test: missing RESEND_API_KEY",
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

	const buildRequest = () =>
		new Request("http://localhost/api/notifications/daily-digest-now", {
			method: "POST",
		});

	it("redirects to /signin?error=unauthorized (302) when user is not authenticated", async () => {
		const response = await POST({
			request: buildRequest(),
			cookies: toAstroCookies(new Map()),
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
	});

	it("redirects to /dashboard?error=daily_digest_disabled (302) when daily digest is disabled", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: true,
			dailyDigestEnabled: false,
			trackedStocks: ["AAPL"],
		});

		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const response = await POST({
				request: buildRequest(),
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=daily_digest_disabled",
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
			dailyDigestEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const response = await POST({
				request: buildRequest(),
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=email_notifications_disabled",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	(hasResendCredentials ? it : it.skip)(
		"redirects to /dashboard?success=daily_digest_sent (302) when user is eligible",
		async () => {
			const { id, email } = await createTestUser({
				email:
					process.env.TEST_EMAIL_RECIPIENT || `test-${randomUUID()}@resend.dev`,
				confirmed: true,
				emailNotificationsEnabled: true,
				dailyDigestEnabled: true,
				trackedStocks: ["AAPL"],
			});

			try {
				const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

				const response = await POST({
					request: buildRequest(),
					cookies: toAstroCookies(cookies),
					redirect: toRedirect,
				} as APIContext);

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe(
					"/dashboard?success=daily_digest_sent",
				);
			} finally {
				await adminClient.auth.admin.deleteUser(id);
			}
		},
	);
});
