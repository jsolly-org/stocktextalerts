import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/notifications/daily-digest-now";
import { adminClient, allowConsoleErrors } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

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

	const buildRequest = (queryParams?: Record<string, string>) => {
		const url = new URL("http://localhost/api/notifications/daily-digest-now");
		if (queryParams) {
			for (const [key, value] of Object.entries(queryParams)) {
				url.searchParams.set(key, value);
			}
		}
		return new Request(url.toString(), {
			method: "POST",
			headers: { Accept: "application/json" },
		});
	};

	it("returns unauthorized when unauthenticated user attempts to send daily digest now", async () => {
		allowConsoleErrors();
		const response = await POST({
			request: buildRequest(),
			cookies: toAstroCookies(new Map()),
		} as APIContext);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});

	it("returns daily_digest_disabled when authenticated user with daily digest disabled attempts to send daily digest now", async () => {
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
			} as APIContext);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("daily_digest_disabled");
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("returns notifications_not_configured when authenticated user with no notification channels attempts to send daily digest now", async () => {
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
			} as APIContext);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("notifications_not_configured");
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("returns daily_digest_rate_limited when authenticated user exceeds manual daily digest send rate limit", async () => {
		const { id, email } = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: true,
			dailyDigestEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			// Exhaust the rate limit by making 5 successful requests (max_requests: 5)
			// The 6th request (via POST below) should be rate limited
			for (let i = 0; i < 5; i++) {
				const { data: allowed, error } = await adminClient.rpc(
					"check_rate_limit",
					{
						p_user_id: id,
						p_endpoint: "daily_digest_now",
						p_max_requests: 5,
						p_window_minutes: 60,
					},
				);

				expect(error).toBeNull();
				expect(allowed).toBe(true);
			}

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const response = await POST({
				request: buildRequest(),
				cookies: toAstroCookies(cookies),
			} as APIContext);

			expect(response.status).toBe(429);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("daily_digest_rate_limited");
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("returns daily_digest_sent and sends email when authenticated user with daily digest enabled, email notifications enabled, and tracked stocks requests to send daily digest now", async () => {
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
			} as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("daily_digest_sent");
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("returns daily_digest_sent when authenticated user has daily digest enabled and SMS enabled+ready (even if email notifications are disabled)", async () => {
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
			} as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("daily_digest_sent");
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});

	it("does not modify next_send_at when sending daily digest now", async () => {
		const { id, email } = await createTestUser({
			email:
				process.env.TEST_EMAIL_RECIPIENT || `test-${randomUUID()}@resend.dev`,
			confirmed: true,
			emailNotificationsEnabled: true,
			dailyDigestEnabled: true,
			trackedStocks: ["AAPL"],
		});

		try {
			const nextSendAt = "2026-01-30T13:00:00.000Z";
			await adminClient
				.from("users")
				.update({ next_send_at: nextSendAt })
				.eq("id", id);

			const cookies = await createAuthenticatedCookies(email, TEST_PASSWORD);

			const response = await POST({
				request: buildRequest(),
				cookies: toAstroCookies(cookies),
			} as APIContext);

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				ok: boolean;
				message: string;
			};
			expect(payload.ok).toBe(true);
			expect(payload.message).toBe("daily_digest_sent");

			const { data: userAfter } = await adminClient
				.from("users")
				.select("next_send_at")
				.eq("id", id)
				.single();

			const nextSendAtAfter = userAfter?.next_send_at;
			expect(nextSendAtAfter).toBeTruthy();
			if (typeof nextSendAtAfter !== "string") {
				throw new Error("Expected next_send_at to be set after test setup");
			}
			const expected = DateTime.fromISO(nextSendAt, { zone: "utc" });
			const actual = DateTime.fromISO(nextSendAtAfter, { zone: "utc" });
			expect(actual.toMillis()).toBe(expected.toMillis());
		} finally {
			await adminClient.auth.admin.deleteUser(id);
		}
	});
});
