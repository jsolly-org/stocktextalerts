import type { EmailRequest, EmailSender } from "../../src/lib/messaging/email/utils";
import type { SmsSender } from "../../src/lib/messaging/sms/twilio-utils";
import type { TelegramMessage, TelegramSender } from "../../src/lib/messaging/telegram/sender";
import type { DeliveryResult } from "../../src/lib/types";

/** OTP accepted by the test double for {@link testCheckVerification}. */
export const TEST_VERIFICATION_CODE = "000000";

/** Deterministic email sender for tests without Mailpit. */
export function createTestEmailSender(): EmailSender {
	return async (_request: EmailRequest): Promise<DeliveryResult> => ({
		success: true,
		messageSid: "mock",
	});
}

/** Deterministic SMS sender; honors `SMS_TEST_*` env knobs per test. */
export function createTestSmsSender(): SmsSender {
	const behavior = process.env.SMS_TEST_BEHAVIOR ?? "success";
	const testMessageSid = process.env.SMS_TEST_MESSAGE_SID ?? "mock";
	const testError = process.env.SMS_TEST_ERROR ?? "Test SMS failure";
	const testErrorCode = process.env.SMS_TEST_ERROR_CODE;

	return async (request) => {
		if (!request.to || !request.body) {
			return {
				success: false,
				error: `Test mock: missing required field(s): ${[!request.to && "to", !request.body && "body"].filter(Boolean).join(", ")}`,
			};
		}
		if (behavior === "fail") {
			return {
				success: false,
				error: testError,
				errorCode: testErrorCode,
			};
		}
		return {
			success: true,
			messageSid: testMessageSid,
		};
	};
}

/** Deterministic Telegram sender; honors `TELEGRAM_TEST_*` env knobs per test. */
export function createTestTelegramSender(): TelegramSender {
	const behavior = process.env.TELEGRAM_TEST_BEHAVIOR ?? "success";
	const testMessageId = process.env.TELEGRAM_TEST_MESSAGE_ID ?? "mock";
	const testError = process.env.TELEGRAM_TEST_ERROR ?? "Test Telegram failure";
	const testErrorCode = process.env.TELEGRAM_TEST_ERROR_CODE;

	return async (message: TelegramMessage): Promise<DeliveryResult> => {
		if (message.chatId === "" || message.chatId === undefined || message.text === "") {
			return { success: false, error: "Test mock: missing required field(s): chatId or text" };
		}
		if (behavior === "fail") {
			return { success: false, error: testError, errorCode: testErrorCode };
		}
		return { success: true, messageSid: testMessageId };
	};
}

export async function testSendVerification(
	_fullPhone: string,
): Promise<{ success: boolean; error?: string }> {
	return { success: true };
}

export async function testCheckVerification(
	_fullPhone: string,
	code: string,
): Promise<{ success: boolean; error?: string }> {
	if (code === TEST_VERIFICATION_CODE) {
		return { success: true };
	}
	return { success: false, error: "Invalid verification code" };
}
