/**
 * Hard-gate regression tests for the three delivery factories.
 *
 * These tests lock in the invariant that tests and dev can NEVER reach
 * real SES/Twilio — the incident on 2026-04-11 happened because the
 * previous gate shape (`MODE === "test" && !liveEmail`) allowed a live
 * test run to construct a real `SESv2Client` and deliver to a real
 * inbox. The factories now refuse to build real clients unless
 * `MODE === "production"`, and live email tests route through local
 * Mailpit via `EMAIL_SMTP_HOST`. If any of these assertions regress,
 * the gate is broken — fix the gate, not the test.
 */
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkVerification, sendVerification } from "../../../src/lib/auth/sms-verification";
import { createEmailSender } from "../../../src/lib/messaging/email/utils";
import { createSmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import { clearMailpit, waitForMailpitMessageTo } from "../../helpers/mailpit";

// Fake Twilio credentials used in the SMS gate tests below. These are
// Twilio's magic test credentials (ACxxxxxxxx... / test auth token) — they
// never hit the network when constructed and never delivery messages even
// if .messages.create is called. We use them directly so the test doesn't
// read real TWILIO_* env vars from .env.local (which would throw in a
// clean checkout and couples test correctness to shell state).
const STUB_TWILIO_ACCOUNT_SID = "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STUB_TWILIO_AUTH_TOKEN = "stubaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STUB_TWILIO_FROM = "+15005550006";

describe("sender gates — no real SES/Twilio in tests", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("createEmailSender", () => {
		it("returns the mock sender when EMAIL_SMTP_HOST is unset", async () => {
			// No stubbing — vitest's MODE is "test", EMAIL_SMTP_HOST is not set,
			// and the factory must fall through to the non-prod mock branch.
			vi.stubEnv("EMAIL_SMTP_HOST", "");
			const send = createEmailSender();
			const result = await send({
				to: "test-gate@example.com",
				subject: "gate",
				body: "should not reach SES",
			});
			expect(result).toMatchObject({ success: true, messageSid: "mock" });
		});

		it("routes through Mailpit via SMTP when EMAIL_SMTP_HOST is set", async () => {
			// This is the live-email path that replaces real SES. Supabase's
			// Inbucket container exposes Mailpit at localhost:1025 for SMTP
			// and localhost:54324 for the HTTP API. Requires `supabase start`.
			vi.stubEnv("EMAIL_SMTP_HOST", "localhost");
			vi.stubEnv("EMAIL_SMTP_PORT", "1025");

			await clearMailpit();
			const send = createEmailSender();
			const recipient = `sender-gate-${Date.now()}@example.com`;
			const result = await send({
				to: recipient,
				subject: "sender-gate smoke test",
				body: "This message was produced by tests/lib/messaging/sender-gates.test.ts",
				html: "<p>smoke</p>",
			});
			expect(result.success).toBe(true);

			const delivered = await waitForMailpitMessageTo(recipient, {
				timeoutMs: 5_000,
			});
			expect(delivered.subject).toBe("sender-gate smoke test");
			expect(delivered.text).toContain("sender-gates.test.ts");
		});
	});

	describe("createSmsSender", () => {
		it("outbound SMS never reaches Twilio in test mode — mock sender intercepts", async () => {
			const fakeClient = twilio(STUB_TWILIO_ACCOUNT_SID, STUB_TWILIO_AUTH_TOKEN);
			const send = createSmsSender(fakeClient, STUB_TWILIO_FROM);
			const result = await send({
				to: "+15005550001",
				body: "Stock alert: AAPL up 5.3% to $195.86",
			});
			// Mock sender's default messageSid is "mock". "test" was the
			// legacy value from the removed LIVE_API_PROVIDERS-gated branch —
			// if a regression renames it, assertions in dependent tests will
			// fail loudly.
			expect(result).toMatchObject({ success: true, messageSid: "mock" });
		});
	});

	describe("Twilio Verify API", () => {
		it("sendVerification short-circuits without calling Twilio", async () => {
			const result = await sendVerification("+15005550001");
			expect(result).toEqual({ success: true });
		});

		it("checkVerification accepts 000000 as the approved code", async () => {
			const result = await checkVerification("+15005550001", "000000");
			expect(result).toEqual({ success: true });
		});

		it("checkVerification rejects any other code", async () => {
			const result = await checkVerification("+15005550001", "123456");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Invalid verification code");
		});
	});
});
