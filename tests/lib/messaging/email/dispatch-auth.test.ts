import { describe, expect, it } from "vitest";
import {
	signEmailDispatchBody,
	verifyEmailDispatchSignature,
} from "../../../../src/lib/messaging/email/dispatch-auth";
import { EMAIL_DISPATCH_TIMESTAMP_TOLERANCE_MS } from "../../../../src/lib/messaging/email/dispatch-contract";

describe("email dispatch HMAC auth", () => {
	const body = JSON.stringify({
		to: "admin@example.com",
		subject: "New signup",
		body: "A user signed up.",
	});
	const timestamp = "1770000000000";
	const secret = "super-secret";

	it("signs and verifies a dispatch body.", () => {
		const signature = signEmailDispatchBody(body, timestamp, secret);

		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp,
				signature,
				secret,
				now: Number(timestamp),
			}),
		).toBe(true);
	});

	it("rejects changed bodies and changed secrets.", () => {
		const signature = signEmailDispatchBody(body, timestamp, secret);

		expect(
			verifyEmailDispatchSignature({
				body: `${body} `,
				timestamp,
				signature,
				secret,
				now: Number(timestamp),
			}),
		).toBe(false);
		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp,
				signature,
				secret: "wrong-secret",
				now: Number(timestamp),
			}),
		).toBe(false);
	});

	it("rejects missing or malformed timestamp and signature values.", () => {
		const signature = signEmailDispatchBody(body, timestamp, secret);

		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp: null,
				signature,
				secret,
				now: Number(timestamp),
			}),
		).toBe(false);
		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp: "not-a-number",
				signature,
				secret,
				now: Number(timestamp),
			}),
		).toBe(false);
		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp,
				signature: "not-hex",
				secret,
				now: Number(timestamp),
			}),
		).toBe(false);
	});

	it("rejects stale timestamps.", () => {
		const signature = signEmailDispatchBody(body, timestamp, secret);

		expect(
			verifyEmailDispatchSignature({
				body,
				timestamp,
				signature,
				secret,
				now: Number(timestamp) + EMAIL_DISPATCH_TIMESTAMP_TOLERANCE_MS + 1,
			}),
		).toBe(false);
	});
});
