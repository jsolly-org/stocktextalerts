import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notifications/daily-digest-now";
import { adminClient } from "../../../setup";
import { createAuthenticatedCookies, createTestUser } from "../../../utils";

const TEST_PASSWORD = "TestPassword123!";

describe("User requests to send daily digest immediately", () => {
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

	const buildRequest = (queryParams?: Record<string, string>) => {
		const url = new URL("http://localhost/api/notifications/daily-digest-now");
		if (queryParams) {
			for (const [key, value] of Object.entries(queryParams)) {
				url.searchParams.set(key, value);
			}
		}
		return new Request(url.toString(), {
			method: "POST",
		});
	};

	it("redirects to /signin?error=unauthorized (302) when unauthenticated user attempts to send daily digest now", async () => {
		const response = await POST({
			request: buildRequest(),
			cookies: toAstroCookies(new Map()),
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
	});

	it("redirects to /dashboard?error=daily_digest_disabled (302) when authenticated user with daily digest disabled attempts to send daily digest now", async () => {
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

	it("redirects to /dashboard?error=email_notifications_disabled (302) when authenticated user with email notifications disabled attempts to send daily digest now", async () => {
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

	it("redirects to /dashboard?success=daily_digest_sent (302) and sends email when authenticated user with daily digest enabled, email notifications enabled, and tracked stocks requests to send daily digest now", async () => {
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
	});

	describe("User chooses to skip the next scheduled digest when sending daily digest immediately", () => {
		it("next_send_at is incremented 24 hours when user with existing next_send_at requests to send daily digest now with skip_next=1", async () => {
			const { id, email } = await createTestUser({
				email:
					process.env.TEST_EMAIL_RECIPIENT || `test-${randomUUID()}@resend.dev`,
				confirmed: true,
				emailNotificationsEnabled: true,
				dailyDigestEnabled: true,
				trackedStocks: ["AAPL"],
				timezone: "America/New_York",
				dailyDigestNotificationTime: 540,
			});

			try {
				const { data: userBefore } = await adminClient
					.from("users")
					.select("next_send_at")
					.eq("id", id)
					.single();

				const originalNextSendAt = userBefore?.next_send_at;

				const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

				const response = await POST({
					request: buildRequest({ skip_next: "1" }),
					cookies: toAstroCookies(cookies),
					redirect: toRedirect,
				} as APIContext);

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe(
					"/dashboard?success=daily_digest_sent",
				);

				const { data: userAfter } = await adminClient
					.from("users")
					.select("next_send_at")
					.eq("id", id)
					.single();

				expect(userAfter?.next_send_at).toBeTruthy();
				if (originalNextSendAt && userAfter?.next_send_at) {
					const original = new Date(originalNextSendAt);
					const advanced = new Date(userAfter.next_send_at);
					expect(advanced.getTime()).toBeGreaterThan(original.getTime());
				}
			} finally {
				await adminClient.auth.admin.deleteUser(id);
			}
		});

		it("ignores skip_next parameter and sends daily digest without modifying next_send_at when user requests send now with skip_next=1 before next_send_at has been set (i.e., before saving preferences after enabling daily digest)", async () => {
			const { id, email } = await createTestUser({
				email:
					process.env.TEST_EMAIL_RECIPIENT || `test-${randomUUID()}@resend.dev`,
				confirmed: true,
				emailNotificationsEnabled: true,
				dailyDigestEnabled: true,
				trackedStocks: ["AAPL"],
				timezone: "America/New_York",
				dailyDigestNotificationTime: 540,
			});

			try {
				await adminClient
					.from("users")
					.update({ next_send_at: null })
					.eq("id", id);

				const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

				const response = await POST({
					request: buildRequest({ skip_next: "1" }),
					cookies: toAstroCookies(cookies),
					redirect: toRedirect,
				} as APIContext);

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe(
					"/dashboard?success=daily_digest_sent",
				);

				const { data: userAfter } = await adminClient
					.from("users")
					.select("next_send_at")
					.eq("id", id)
					.single();

				expect(userAfter?.next_send_at).toBeNull();
			} finally {
				await adminClient.auth.admin.deleteUser(id);
			}
		});
	});
});
