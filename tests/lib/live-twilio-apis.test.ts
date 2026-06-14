import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { assertLiveProviderKey, isLiveProviderEnabled } from "../helpers/live-api";

/**
 * Twilio `--live=twilio` is split across two files by design — a consequence of
 * Twilio's testing model (see https://www.twilio.com/docs/iam/test-credentials):
 *
 *   - THIS file uses account-level TEST CREDENTIALS + magic numbers. That is the
 *     only no-charge / no-real-delivery path Twilio offers, but magic numbers
 *     ONLY work under test credentials — they do NOT work with a live Restricted
 *     key. So this file canaries request/response SHAPE and error codes, not the
 *     production credential. (Verify isn't supported under test creds at all —
 *     non-SMS/Call/Lookup resources return 403 with test creds.)
 *   - live-twilio-scope.test.ts uses the real PRODUCTION Restricted key to
 *     canary the credential itself (auth + exact scope), with no billable send
 *     (invalid-input → 400 for in-scope; 401/70051 for out-of-scope).
 *
 * The two together remove the credential skew on auth/scope while staying free.
 * End-to-end DELIVERY is verified by production monitoring (the every-minute
 * schedule Lambda + ErrorLogAlarm), per Twilio's guidance — not a billable test.
 */

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

describe("Twilio live API (test credentials only, opt-in)", () => {
	if (!isLiveProviderEnabled("twilio")) {
		it.skip("runs only when --live=twilio is enabled", () => {});
		return;
	}

	assertLiveProviderKey({
		provider: "twilio",
		envVar: "TWILIO_TEST_ACCOUNT_SID",
	});
	assertLiveProviderKey({
		provider: "twilio",
		envVar: "TWILIO_TEST_AUTH_TOKEN",
	});

	const accountSid = requireEnv("TWILIO_TEST_ACCOUNT_SID");
	const authToken = requireEnv("TWILIO_TEST_AUTH_TOKEN");
	const client = twilio(accountSid, authToken);
	const from = "+15005550006";

	it("accepts a magic-number SMS send request with test credentials", {
		timeout: 30_000,
		retry: 1,
	}, async () => {
		const message = await client.messages.create({
			body: `stocktextalerts live twilio test ${Date.now()}`,
			from,
			to: "+15005550006",
		});

		expect(typeof message.sid).toBe("string");
		expect(message.sid.length).toBeGreaterThan(0);
		expect(message.from).toBe(from);
		expect(message.to).toBe("+15005550006");
	});

	it("returns expected Twilio validation error for non-mobile magic number", {
		timeout: 30_000,
		retry: 1,
	}, async () => {
		await expect(
			client.messages.create({
				body: "stocktextalerts live twilio negative test",
				from,
				to: "+15005550009",
			}),
		).rejects.toMatchObject({
			code: 21614,
		});
	});
});
