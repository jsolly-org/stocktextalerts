/**
 * Regression tests for outbound messaging test doubles wired in tests/setup.ts.
 *
 * Production factories (SES, Twilio, Telegram Bot API, Verify) no longer branch on
 * runtime mode. The suite stubs them via tests/helpers/messaging-doubles.ts so
 * unit/integration tests never hit real delivery endpoints.
 */
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkVerification, sendVerification } from "../../../src/lib/auth/sms-verification";
import { createEmailSender } from "../../../src/lib/messaging/email/utils";
import { createSmsSender } from "../../../src/lib/messaging/sms/twilio-utils";
import {
	createTelegramBot,
	createTelegramSender,
} from "../../../src/lib/messaging/telegram/sender";
import { clearMailpit, waitForMailpitMessageTo } from "../../helpers/mailpit";
import { TEST_VERIFICATION_CODE } from "../../helpers/messaging-doubles";

const STUB_TELEGRAM_TOKEN = "123456:AA-fake-token-for-sender-gate-tests-only";
const STUB_TWILIO_ACCOUNT_SID = "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STUB_TWILIO_AUTH_TOKEN = "stubaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STUB_TWILIO_FROM = "+15005550006";

describe("messaging test doubles — no real SES/Twilio/Telegram/Verify in tests", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("createEmailSender", () => {
		it("returns the setup mock sender when EMAIL_SMTP_HOST is unset", async () => {
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
			vi.stubEnv("EMAIL_SMTP_HOST", "localhost");

			await clearMailpit();
			const send = createEmailSender();
			const recipient = `sender-gate-${Date.now()}@example.com`;
			const result = await send({
				to: recipient,
				subject: "sender-gate smoke test",
				body: "This message was produced by tests/lib/messaging/senders.test.ts",
				html: "<p>smoke</p>",
			});
			expect(result.success).toBe(true);

			const delivered = await waitForMailpitMessageTo(recipient, {
				timeoutMs: 5_000,
			});
			expect(delivered.subject).toBe("sender-gate smoke test");
			expect(delivered.text).toContain("senders.test.ts");
		});
	});

	describe("createSmsSender", () => {
		it("uses the setup mock sender instead of calling Twilio", async () => {
			const fakeClient = twilio(STUB_TWILIO_ACCOUNT_SID, STUB_TWILIO_AUTH_TOKEN);
			const send = createSmsSender(fakeClient, STUB_TWILIO_FROM);
			const result = await send({
				to: "+15005550001",
				body: "Stock alert: AAPL up 5.3% to $195.86",
			});
			expect(result).toMatchObject({ success: true, messageSid: "mock" });
		});
	});

	describe("createTelegramSender", () => {
		it("uses the setup mock sender instead of calling the Bot API", async () => {
			const bot = createTelegramBot(STUB_TELEGRAM_TOKEN);
			const send = createTelegramSender(bot);
			const result = await send({
				chatId: 5550001,
				text: "AAPL up 5.3% to $195.86",
			});
			expect(result).toMatchObject({ success: true, messageSid: "mock" });
		});

		it("honors TELEGRAM_TEST_BEHAVIOR=fail without touching the network", async () => {
			vi.stubEnv("TELEGRAM_TEST_BEHAVIOR", "fail");
			vi.stubEnv("TELEGRAM_TEST_ERROR", "Simulated Telegram failure");
			vi.stubEnv("TELEGRAM_TEST_ERROR_CODE", "403");
			const send = createTelegramSender(createTelegramBot(STUB_TELEGRAM_TOKEN));
			const result = await send({ chatId: 5550001, text: "AAPL update" });
			expect(result).toMatchObject({
				success: false,
				error: "Simulated Telegram failure",
				errorCode: "403",
			});
		});
	});

	describe("Twilio Verify API", () => {
		it("sendVerification uses the setup mock without calling Twilio", async () => {
			const result = await sendVerification("+15005550001");
			expect(result).toEqual({ success: true });
		});

		it("checkVerification accepts the test OTP", async () => {
			const result = await checkVerification("+15005550001", TEST_VERIFICATION_CODE);
			expect(result).toEqual({ success: true });
		});

		it("checkVerification rejects any other code", async () => {
			const result = await checkVerification("+15005550001", "123456");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Invalid verification code");
		});
	});
});
