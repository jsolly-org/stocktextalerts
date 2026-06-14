import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { assertLiveProviderKey, isLiveProviderEnabled } from "../helpers/live-api";

/**
 * Scope-enforcement tests for the live `stocktextalerts-runtime` Twilio
 * Restricted API key (TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET).
 *
 * Twilio enforces a Restricted key's permissions server-side, so this can only
 * be verified against the real API — hence it is gated behind `--live=twilio`.
 *
 * The key is expected to hold EXACTLY: Verify (create + check) and Messaging
 * (create). These tests assert both directions of that boundary:
 *   - HAS (in-scope):  the call reaches the resource. We send deliberately
 *     invalid input so an authorized key gets a 400 validation error and an
 *     UN-authorized key would get 401/403 — proving the permission without
 *     actually sending an SMS or OTP (no delivery, no charge).
 *   - LACKS (out-of-scope): the call is rejected with HTTP 401 + Twilio code
 *     70051 (Restricted-key authorization error). A read/list on Messages
 *     (create-only) and any Voice call must be denied. If either unexpectedly
 *     succeeds, the key is over-permissioned and this test fails.
 */

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
// Twilio's authorization error for a Restricted API key that lacks a permission.
const RESTRICTED_KEY_DENIED_CODE = 70051;
const INVALID_PHONE = "not-a-phone-number";

describe("Twilio Restricted key scope enforcement (stocktextalerts-runtime)", () => {
	if (!isLiveProviderEnabled("twilio")) {
		it.skip("runs only when --live=twilio is enabled", () => {});
		return;
	}

	assertLiveProviderKey({ provider: "twilio", envVar: "TWILIO_API_KEY_SID" });
	assertLiveProviderKey({ provider: "twilio", envVar: "TWILIO_API_KEY_SECRET" });

	const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
	const apiKeySid = requireEnv("TWILIO_API_KEY_SID");
	const apiKeySecret = requireEnv("TWILIO_API_KEY_SECRET");
	const fromNumber = requireEnv("TWILIO_PHONE_NUMBER");
	const verifyServiceSid = requireEnv("TWILIO_VERIFY_SERVICE_SID");
	const client = twilio(apiKeySid, apiKeySecret, { accountSid });

	it("uses a Restricted (SK) API key, not a Standard/Main key", () => {
		expect(apiKeySid.startsWith("SK")).toBe(true);
	});

	it("HAS Messaging:create — an invalid send reaches the resource (400, not 401)", {
		timeout: 30_000,
		retry: 1,
	}, async () => {
		const err = await client.messages
			.create({ from: fromNumber, to: INVALID_PHONE, body: "scope probe" })
			.then(
				() => null,
				(e) => e,
			);
		expect(err, "expected a validation error, not a successful send").not.toBeNull();
		expect(
			err.status,
			`Messaging:create should be authorized (400 invalid input); got ${err.status}/${err.code}`,
		).toBe(HTTP_BAD_REQUEST);
	});

	it("HAS Verify:create — an invalid verification reaches the resource (400, not 401)", {
		timeout: 30_000,
		retry: 1,
	}, async () => {
		const err = await client.verify.v2
			.services(verifyServiceSid)
			.verifications.create({ to: INVALID_PHONE, channel: "sms" })
			.then(
				() => null,
				(e) => e,
			);
		expect(err, "expected a validation error, not a successful OTP send").not.toBeNull();
		expect(
			err.status,
			`Verify:create should be authorized (400 invalid input); got ${err.status}/${err.code}`,
		).toBe(HTTP_BAD_REQUEST);
	});

	it("LACKS Messaging:read — messages(sid).fetch is denied (create-only key)", {
		timeout: 30_000,
		retry: 1,
	}, async () => {
		// A read-authorized key would get 404 (not found) for a bogus SID; a
		// create-only key is denied outright (401/70051) before existence is checked.
		const bogusMessageSid = "SM00000000000000000000000000000000";
		const err = await client
			.messages(bogusMessageSid)
			.fetch()
			.then(
				() => null,
				(e) => e,
			);
		expect(
			err,
			"messages.fetch unexpectedly succeeded — key has more than Messaging:create",
		).not.toBeNull();
		expect(
			err.code,
			`messages.fetch should be denied (401/70051); got ${err.status}/${err.code}`,
		).toBe(RESTRICTED_KEY_DENIED_CODE);
		expect(err.status).toBe(HTTP_UNAUTHORIZED);
	});

	it("LACKS Voice — calls.list is denied", { timeout: 30_000, retry: 1 }, async () => {
		const err = await client.calls.list({ limit: 1 }).then(
			() => null,
			(e) => e,
		);
		expect(
			err,
			"calls.list unexpectedly succeeded — key has an unexpected Voice scope",
		).not.toBeNull();
		expect(err.code, `calls.list should be denied (401/70051); got ${err.status}/${err.code}`).toBe(
			RESTRICTED_KEY_DENIED_CODE,
		);
		expect(err.status).toBe(HTTP_UNAUTHORIZED);
	});
});
