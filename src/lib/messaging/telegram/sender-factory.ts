import type { Bot } from "grammy";
import { isProduction } from "../../runtime/mode";
import { createTelegramBot, createTelegramSender, readTelegramBotToken } from "./sender";

interface TelegramSenderResult {
	sender: ReturnType<typeof createTelegramSender>;
}

export type TelegramSenderFactory = () => TelegramSenderResult;

/**
 * Create a lazily-initialized, cached Telegram sender factory for batch notification runs.
 *
 * Mirrors `createSmsSenderFactory`: caches the bot/sender across the run, and
 * non-production short-circuits before reading `TELEGRAM_BOT_TOKEN`. The hard gate
 * inside `createTelegramSender` already blocks real API calls; gating here too lets
 * a clean checkout with no token run the full scheduler pipeline in tests.
 */
export function createTelegramSenderFactory(): TelegramSenderFactory {
	let bot: Bot | null = null;
	let sendTelegram: ReturnType<typeof createTelegramSender> | null = null;

	return () => {
		if (sendTelegram) {
			return { sender: sendTelegram };
		}

		if (!isProduction()) {
			// Sentinel bot — the mock branch inside createTelegramSender ignores it,
			// so this never constructs a network-capable Bot or reads the token.
			sendTelegram = createTelegramSender(null as unknown as Bot);
			return { sender: sendTelegram };
		}

		if (!bot) {
			bot = createTelegramBot(readTelegramBotToken());
		}
		sendTelegram = createTelegramSender(bot);
		return { sender: sendTelegram };
	};
}
