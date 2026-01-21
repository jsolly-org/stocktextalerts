import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { DateTime } from "luxon";
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

	it("redirects to /dashboard?error=notifications_not_configured (302) when authenticated user with no notification channels attempts to send daily digest now", async () => {
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
				"/dashboard?error=notifications_not_configured",
			);
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("redirects to /dashboard?error=daily_digest_rate_limited (302) when authenticated user exceeds manual daily digest send rate limit", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: true,
			dailyDigestEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			const { data: allowed, error } = await adminClient.rpc(
				"check_rate_limit",
				{
					p_user_id: id,
					p_endpoint: "daily_digest_now",
					p_max_requests: 1,
					p_window_minutes: 60,
				},
			);

			expect(error).toBeNull();
			expect(allowed).toBe(true);

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const response = await POST({
				request: buildRequest(),
				cookies: toAstroCookies(cookies),
				redirect: toRedirect,
			} as APIContext);

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				"/dashboard?error=daily_digest_rate_limited",
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

	it("redirects to /dashboard?success=daily_digest_sent (302) when authenticated user has daily digest enabled and SMS enabled+ready (even if email notifications are disabled)", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: false,
			smsNotificationsEnabled: true,
			phoneVerified: true,
			smsOptedOut: false,
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
		it("next_send_at is advanced when user with existing next_send_at requests to send daily digest now with skip_next=1", async () => {
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
					const original = DateTime.fromISO(originalNextSendAt, {
						zone: "utc",
					});
					const advanced = DateTime.fromISO(userAfter.next_send_at, {
						zone: "utc",
					});
					const deltaMs = advanced.toMillis() - original.toMillis();
					const expectedMs = 24 * 60 * 60 * 1000;
					const toleranceMs = 5 * 60 * 1000;
					expect(Math.abs(deltaMs - expectedMs)).toBeLessThanOrEqual(
						toleranceMs,
					);
					expect(deltaMs).toBeGreaterThan(0);
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
