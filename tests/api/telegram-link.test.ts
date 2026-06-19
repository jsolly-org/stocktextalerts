import { describe, expect, it } from "vitest";
import { verifyLinkToken } from "../../src/lib/auth/deep-link-token";
import { POST } from "../../src/pages/api/telegram/link";
import { createApiContext } from "../helpers/api-context";
import { adminClient, createAuthenticatedCookies } from "../helpers/test-env";
import { createTestUser } from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

const TEST_PASSWORD = "TestPassword123!";

function buildLinkRequest(): Request {
	return new Request("http://localhost/api/telegram/link", {
		method: "POST",
		headers: { Accept: "application/json" },
	});
}

describe("A signed-in user starts linking their Telegram account.", () => {
	it("returns a t.me deep link and persists a single-use token bound to that user.", async () => {
		const testUser = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const response = await POST(createApiContext({ request: buildLinkRequest(), cookies }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; deepLink: string };
		expect(body.ok).toBe(true);
		expect(body.deepLink).toMatch(/^https:\/\/t\.me\/[^?]+\?start=[A-Za-z0-9_-]{1,64}$/);

		const token = new URL(body.deepLink).searchParams.get("start");
		expect(token).not.toBeNull();
		if (!token) throw new Error("expected start token");

		// The token's signature verifies, and its nonce maps to a fresh,
		// unconsumed row bound to THIS user.
		const verified = verifyLinkToken(token);
		expect(verified).not.toBeNull();
		if (!verified) throw new Error("expected verified token");

		const { data: row } = await adminClient
			.from("telegram_link_tokens")
			.select("user_id,consumed_at,expires_at")
			.eq("nonce", verified.nonce)
			.single();
		expect(row).not.toBeNull();
		if (!row) throw new Error("expected token row");
		expect(row.user_id).toBe(testUser.id);
		expect(row.consumed_at).toBeNull();
		expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
	});

	it("rejects an unauthenticated request with 401 and persists no token.", async () => {
		const response = await POST(
			createApiContext({ request: buildLinkRequest(), cookies: new Map() }),
		);

		expect(response.status).toBe(401);
		const body = (await response.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
