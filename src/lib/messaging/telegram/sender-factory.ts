import type { Bot } from "grammy";
import { createTelegramBot, createTelegramSender, readTelegramBotToken } from "./sender";
import type { TelegramSenderFactory } from "./types";

/**
 * Create a lazily-initialized, cached Telegram sender factory for batch notification runs.
 *
 * Mirrors `createSmsSenderFactory`: caches the bot/sender across the run.
 */
export function createTelegramSenderFactory(): TelegramSenderFactory {
	let bot: Bot | null = null;
	let sendTelegram: ReturnType<typeof createTelegramSender> | null = null;

	return () => {
		if (sendTelegram) {
			return { sender: sendTelegram };
		}

		if (!bot) {
			bot = createTelegramBot(readTelegramBotToken());
		}
		sendTelegram = createTelegramSender(bot);
		return { sender: sendTelegram };
	};
}
