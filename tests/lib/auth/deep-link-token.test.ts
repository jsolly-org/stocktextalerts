import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintLinkToken, verifyLinkToken } from "../../../src/lib/auth/deep-link-token";

const TELEGRAM_START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

describe("A dashboard mints a Telegram deep-link token that the bot later verifies.", () => {
	it("mint -> verify round-trips: the token verifies and yields the same nonce that was persisted.", () => {
		const minted = mintLinkToken({ userId: randomUUID(), ttlMs: 10 * 60 * 1000 });

		const verified = verifyLinkToken(minted.token);
		expect(verified).not.toBeNull();
		expect(verified?.nonce).toBe(minted.nonce);
	});

	it("the emitted token fits Telegram's /start payload constraint (^[A-Za-z0-9_-]{1,64}$).", () => {
		// Run several mints so a stray padding/encoding char would be caught.
		for (let i = 0; i < 50; i += 1) {
			const { token } = mintLinkToken({ userId: randomUUID(), ttlMs: 60_000 });
			expect(token).toMatch(TELEGRAM_START_PAYLOAD);
			expect(token.length).toBeLessThanOrEqual(64);
			expect(token).not.toContain(".");
		}
	});

	it("reports the requested expiry as an absolute ms timestamp for server-side persistence.", () => {
		const now = 1_700_000_000_000;
		const { expiresAtMs } = mintLinkToken({ userId: randomUUID(), ttlMs: 10 * 60 * 1000, now });
		expect(expiresAtMs).toBe(now + 10 * 60 * 1000);
	});

	it("a tampered token (flipped signature byte) fails verification.", () => {
		const { token } = mintLinkToken({ userId: randomUUID(), ttlMs: 60_000 });

		// Flip the final character to corrupt the truncated HMAC.
		const last = token.at(-1);
		const swapped = last === "A" ? "B" : "A";
		const tampered = token.slice(0, -1) + swapped;
		expect(tampered).not.toBe(token);

		expect(verifyLinkToken(tampered)).toBeNull();
	});

	it("a token of valid shape but bogus signature is rejected (no forging /start payloads).", () => {
		// 30 random bytes -> 40 base64url chars, the right shape but wrong HMAC.
		const forged = Buffer.from(new Uint8Array(30).fill(7)).toString("base64url");
		expect(forged).toMatch(TELEGRAM_START_PAYLOAD);
		expect(verifyLinkToken(forged)).toBeNull();
	});

	it("malformed inputs (empty, illegal chars, wrong length) are rejected without throwing.", () => {
		expect(verifyLinkToken("")).toBeNull();
		expect(verifyLinkToken("has spaces and !!!")).toBeNull();
		// Valid base64url charset but decodes to the wrong byte length.
		expect(verifyLinkToken("abc")).toBeNull();
		expect(verifyLinkToken("A".repeat(64))).toBeNull();
	});
});
