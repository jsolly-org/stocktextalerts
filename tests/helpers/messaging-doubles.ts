import type {
	EmailRequest,
	EmailSender,
	TelegramMessage,
	TelegramSender,
} from "../../src/lib/messaging/types";
import type { DeliveryResult } from "../../src/lib/types";

/**
 * Extract the deep-link URL of the first inline-keyboard button on a Telegram
 * message, narrowing the `InlineKeyboardButton` union (only the URL variant has
 * `url`). Returns undefined when there's no button (e.g. a buttonless legacy row).
 */
export function dashboardButtonUrl(message: TelegramMessage | undefined): string | undefined {
	const button = message?.replyMarkup?.inline_keyboard[0]?.[0];
	return button && "url" in button ? button.url : undefined;
}

/** Deterministic email sender for tests without Mailpit. */
export function createTestEmailSender(): EmailSender {
	return async (_request: EmailRequest): Promise<DeliveryResult> => ({
		success: true,
		messageSid: "mock",
	});
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
