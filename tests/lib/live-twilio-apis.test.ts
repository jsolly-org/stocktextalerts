import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { assertLiveProviderKey, isLiveProviderEnabled } from "../helpers/live-api";

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
