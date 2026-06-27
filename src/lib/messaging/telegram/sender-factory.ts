import type { Bot } from "grammy";
import { createTelegramBot, createTelegramSender, readTelegramBotToken } from "./sender";

interface TelegramSenderResult {
	sender: ReturnType<typeof createTelegramSender>;
}

export type TelegramSenderFactory = () => TelegramSenderResult;

/**
 * Create a lazily-initialized, cached Telegram sender factory for batch notification runs.
 *
 * Mirrors `createSmsSenderFactory`: caches the bot/sender across the run.
 * Tests stub `createTelegramSender` in tests/setup.ts — no production gate here.
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
