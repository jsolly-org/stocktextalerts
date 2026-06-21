import { Agent } from "node:https";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, InputFile } from "grammy";
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import { isProduction } from "../../runtime/mode";
import type { DeliveryResult } from "../types";

/** A fully-rendered outbound Telegram message (text carries out-of-band entities). */
export interface TelegramMessage {
	chatId: number | string;
	/** Plain text; formatting travels via `entities`, not parse_mode. */
	text: string;
	/** Entity markers (offset/length) from the parse-mode `fmt` builder. */
	entities?: MessageEntity[];
	/** When present, send as a photo with `text` as the caption (≤1024 chars). */
	photo?: Buffer;
	/** Inline keyboard for actionable alerts. */
	replyMarkup?: InlineKeyboardMarkup;
	/** Silent delivery (e.g. routine digest) — maps to Telegram's disable_notification. */
	disableNotification?: boolean;
}

export type TelegramSender = (message: TelegramMessage) => Promise<DeliveryResult>;

/**
 * Perform the real Telegram send for a single message via grammY's `bot.api`.
 *
 * This is the actual production send path — `sendPhoto` when a chart Buffer is
 * present, `sendMessage` otherwise — extracted from {@link createTelegramSender}
 * so it is reachable in tests **without** flipping `isProduction()`. Tests install
 * a capturing transformer (`bot.api.config.use(...)`) that returns a fake API
 * response, exercising the real (method, payload) construction (entities,
 * InputFile, link_preview_options, disable_notification) the hard non-prod mock
 * otherwise skips entirely.
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

/** Read the bot token (a write credential — Lambda/Vercel runtime only, never tests). */
export function readTelegramBotToken(): string {
	return requireEnv("TELEGRAM_BOT_TOKEN");
}

/**
 * Construct a grammY Bot with the auto-retry transformer installed.
 *
 * auto-retry owns 429/flood and transient 5xx handling: it detects `retry_after`
 * and waits exactly that long before retrying. We therefore do NOT add artificial
 * pacing and do NOT wrap sends in `withDeliveryRetry` — stacking a second retry
 * loop around a 429 would ignore `retry_after` and risk a bot ban
 * (see docs/plans/2026-06-19-telegram-native-channel.md §2).
 *
 * Two client tweaks make this survivable in the Lambda runtime:
 *
 *  - **IPv4-pinned agent.** grammY ships `node-fetch` + a keep-alive `https.Agent`,
 *    which uses Node's native HTTPS stack. `api.telegram.org` publishes AAAA records,
 *    but a Lambda outside a VPC has IPv4-only egress, and node-fetch's path has no
 *    Happy-Eyeballs fallback — so an IPv6 connect attempt black-holes and the request
 *    hangs until the function's 300s ceiling (the Massive/Finnhub providers dodge this
 *    only because they call the global `fetch`/undici, which does fall back to IPv4).
 *    Pinning the agent to `family: 4` forces the IPv4 endpoint — but this did NOT
 *    resolve the Lambda→api.telegram.org stall, so the `useUndiciFetch` option below
 *    is the current candidate fix (routing through undici, which the working
 *    Massive/Finnhub checks already use). The send path keeps the IPv4 agent until
 *    undici is proven from the Lambda runtime.
 *  - **Bounded request timeout.** grammY's own `timeoutSeconds` defaults to 500s —
 *    longer than any Lambda ceiling, so a stalled call can never self-abort. Cap it
 *    so a hung request fails loudly instead of consuming the whole invocation.
 */
export function createTelegramBot(
	token: string,
	{
		timeoutSeconds = 25,
		useUndiciFetch = false,
		withAutoRetry = true,
	}: { timeoutSeconds?: number; useUndiciFetch?: boolean; withAutoRetry?: boolean } = {},
): Bot {
	const bot = new Bot(token, {
		client: {
			// `useUndiciFetch` routes through Node's global fetch (undici) instead of grammY's
			// default node-fetch — the candidate fix for the Lambda→api.telegram.org stall
			// (full rationale in this function's JSDoc). The send path keeps the IPv4 agent;
			// the health check opts into undici.
			...(useUndiciFetch
				? { fetch: globalThis.fetch }
				: { baseFetchConfig: { agent: new Agent({ keepAlive: true, family: 4 }) } }),
			timeoutSeconds,
		},
	});
	// auto-retry owns 429/flood + transient-5xx handling for the high-volume send path.
	// The health probe opts OUT (`withAutoRetry: false`): a one-shot getMe/getWebhookInfo
	// must fail fast with the real transport error, not retry a network failure through
	// 3s/6s/12s backoff that outlives the caller's timeout race.
	if (withAutoRetry) {
		bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
	}
	return bot;
}

/**
 * Create a Telegram sender function.
 *
 * Like SMS, Telegram has **no live test tier**: tests and `astro dev` always get a
 * deterministic mock, because the harness can't prevent real delivery or charges
 * (here: real messages to real chats). The hard `!isProduction()` gate means even if
 * upstream constructs a real Bot from a token in `.env.local`, we never call its API.
 * Mock behavior is driven by `TELEGRAM_TEST_BEHAVIOR` / `TELEGRAM_TEST_ERROR(_CODE)` /
 * `TELEGRAM_TEST_MESSAGE_ID`, mirroring the `SMS_TEST_*` knobs.
 */
export function createTelegramSender(bot: Bot): TelegramSender {
	if (!isProduction()) {
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

	return (message: TelegramMessage): Promise<DeliveryResult> => sendViaBot(bot, message);
}
