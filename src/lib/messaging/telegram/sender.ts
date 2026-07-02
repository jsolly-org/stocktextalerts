import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, InputFile } from "grammy";
import { requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import type { DeliveryResult } from "../../types";
import type { TelegramMessage, TelegramSender } from "../types";

/**
 * Perform the real Telegram send for a single message via grammY's `bot.api`.
 *
 * This is the production send path — `sendPhoto` when a chart Buffer is
 * present, `sendMessage` otherwise.
 *
 * grammY maps a Bot-API error response to a thrown `GrammyError` (see
 * `core/client.ts#callApi`), which we translate to a `{ success: false, errorCode }`
 * result — error_code 403 ("bot was blocked by the user") is handled by the caller,
 * which maps it to telegram_opted_out (never set opt-out from inbound content).
 */
export async function sendViaBot(bot: Bot, message: TelegramMessage): Promise<DeliveryResult> {
	try {
		const sent = message.photo
			? await bot.api.sendPhoto(message.chatId, new InputFile(message.photo, "chart.png"), {
					caption: message.text,
					caption_entities: message.entities,
					reply_markup: message.replyMarkup,
					disable_notification: message.disableNotification,
				})
			: await bot.api.sendMessage(message.chatId, message.text, {
					entities: message.entities,
					reply_markup: message.replyMarkup,
					disable_notification: message.disableNotification,
					link_preview_options: { is_disabled: true },
				});
		return { success: true, messageSid: String(sent.message_id) };
	} catch (error) {
		rootLogger.debug("Telegram send attempt failed", {
			action: "send_telegram",
			chatId: String(message.chatId),
			error: error instanceof Error ? error.message : String(error),
		});
		if (error instanceof GrammyError) {
			return { success: false, error: error.description, errorCode: String(error.error_code) };
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to send Telegram message",
		};
	}
}

/** Read the bot token (a write credential — Lambda/Vercel runtime only). */
export function readTelegramBotToken(): string {
	return requireEnv("TELEGRAM_BOT_TOKEN");
}

/**
 * Construct a grammY Bot routed through undici (Node's global fetch), with the
 * auto-retry transformer installed for the send path.
 *
 * **Why undici, not grammY's default node-fetch.** grammY's bundled node-fetch stack
 * stalls connecting to `api.telegram.org` from AWS Lambda — the request hangs to the
 * 300s ceiling (the IPv4-agent pin did NOT fix it). undici — the same fetch the working
 * Massive/Finnhub provider checks use — reaches it fine (verified: the live-provider-check
 * telegram probe went from a 300s timeout to a 381ms pass). So every bot routes through a
 * `globalThis.fetch` wrapper that:
 *  - substitutes a per-request **global `AbortSignal.timeout`**, because grammY's own
 *    `timeoutSeconds` AbortSignal is a non-global class undici rejects ("RequestInit:
 *    Expected signal to be an instance of AbortSignal"); and
 *  - sets **`duplex: "half"`** for streamed request bodies (the multipart sendPhoto chart
 *    upload), which undici requires.
 *
 * auto-retry owns 429/flood + transient-5xx handling for the high-volume send path (it
 * honors `retry_after`); we do NOT stack a second retry loop (it would ignore `retry_after`
 * and risk a bot ban — see docs/plans/2026-06-19-telegram-native-channel.md §2). The
 * read-only health probe opts OUT (`withAutoRetry: false`) so a one-shot getMe fails fast.
 */
export function createTelegramBot(
	token: string,
	{
		timeoutSeconds = 25,
		withAutoRetry = true,
	}: { timeoutSeconds?: number; withAutoRetry?: boolean } = {},
): Bot {
	const undiciFetch: typeof fetch = (input, init) => {
		const reqInit: RequestInit & { duplex?: "half" } = {
			...init,
			signal: AbortSignal.timeout(timeoutSeconds * 1000),
		};
		// undici requires `duplex` when a (streamed) body is present — e.g. the multipart
		// sendPhoto upload. Harmless on bodiless GETs and string bodies.
		if (init?.body != null) reqInit.duplex = "half";
		return globalThis.fetch(input, reqInit);
	};
	const bot = new Bot(token, { client: { fetch: undiciFetch } });
	// auto-retry owns 429/flood + transient-5xx handling for the high-volume send path.
	// The health probe opts OUT (`withAutoRetry: false`): a one-shot getMe/getWebhookInfo
	// must fail fast with the real transport error, not retry a network failure through
	// 3s/6s/12s backoff that outlives the caller's timeout race.
	if (withAutoRetry) {
		bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
	}
	return bot;
}

/** Create a Telegram sender function backed by the supplied bot. */
export function createTelegramSender(bot: Bot): TelegramSender {
	return (message: TelegramMessage): Promise<DeliveryResult> => sendViaBot(bot, message);
}
