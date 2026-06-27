import type { Bot } from "grammy";
import {
	createTelegramBot,
	createTelegramSender,
	readTelegramBotToken,
} from "../messaging/telegram/sender";

interface TelegramSenderResult {
	sender: ReturnType<typeof createTelegramSender>;
}

export type TelegramSenderProvider = () => TelegramSenderResult;

/**
 * Create a lazily-initialized, cached Telegram sender provider for scheduler runs.
 *
 * Mirrors `createSmsSenderProvider`: caches the bot/sender across the run.
 */
export function createTelegramSenderProvider(): TelegramSenderProvider {
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
