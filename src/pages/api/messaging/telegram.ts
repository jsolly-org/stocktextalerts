import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { verifyLinkToken } from "../../../lib/auth/deep-link-token";
import { requireEnv } from "../../../lib/db/env";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";
import {
	createTelegramBot,
	createTelegramSender,
	readTelegramBotToken,
} from "../../../lib/messaging/telegram/sender";

const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Constant-time compare of the request's secret-token header against the
 * configured webhook secret. Returns false on any length mismatch (encoding the
 * comparison to equal-length buffers first, so `timingSafeEqual` never throws).
 */
function secretMatches(presented: string | null, expected: string): boolean {
	if (!presented) return false;
	const presentedBuffer = Buffer.from(presented, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");
	if (presentedBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(presentedBuffer, expectedBuffer);
}

/** Narrow shape of the slice of a Telegram Update we act on. */
type TelegramUpdate = {
	update_id?: unknown;
	message?: {
		text?: unknown;
		chat?: { id?: unknown };
		from?: { id?: unknown };
	};
};

/** Extract `/start <payload>` (or bare `/start`) from message text. */
function parseStartCommand(text: string): { isStart: boolean; payload: string | null } {
	const trimmed = text.trim();
	if (trimmed !== "/start" && !trimmed.startsWith("/start ")) {
		return { isStart: false, payload: null };
	}
	const rest = trimmed.slice("/start".length).trim();
	return { isStart: true, payload: rest.length > 0 ? rest : null };
}

/**
 * POST /api/messaging/telegram — the bot webhook.
 *
 * Security contract (non-negotiable):
 *  1. FAIL CLOSED: `requireEnv('TELEGRAM_WEBHOOK_SECRET')` is read first; a
 *     missing/wrong `X-Telegram-Bot-Api-Secret-Token` header returns 401 and
 *     mutates NOTHING.
 *  2. DEDUPE: insert `update_id` into `telegram_updates` ON CONFLICT DO NOTHING;
 *     a repeat returns 200 without processing (Telegram re-sends on non-2XX).
 *  3. ATOMIC SINGLE-USE: `/start <token>` is verified (constant-time signature),
 *     then the matching `telegram_link_tokens` row is consumed in ONE conditional
 *     UPDATE (`consumed_at IS NULL AND expires_at > now()` ... RETURNING user_id`).
 *     Zero rows → reject; no fail-open if the nonce row is absent. The chat is
 *     linked to the token row's `user_id` — NEVER to `from.id`.
 *  4. Always return 2XX after the secret check passes (even on user error) so
 *     Telegram does not retry; failures are logged instead.
 */
export const POST: APIRoute = async ({ url, request, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	// (1) Fail closed. Read the secret first; reject before touching the DB.
	const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
	const presentedSecret = request.headers.get(SECRET_TOKEN_HEADER);
	if (!secretMatches(presentedSecret, webhookSecret)) {
		logger.info("Telegram webhook rejected: missing or invalid secret token", {
			hasHeader: presentedSecret !== null,
		});
		return new Response("unauthorized", { status: 401 });
	}

	let update: TelegramUpdate;
	try {
		update = (await request.json()) as TelegramUpdate;
	} catch (error) {
		// Malformed body after a valid secret — log and 200 so Telegram drops it.
		logger.info("Telegram webhook received unparseable body", {
			error: error instanceof Error ? error.message : String(error),
		});
		return new Response("ok", { status: 200 });
	}

	const updateId = typeof update.update_id === "number" ? update.update_id : null;
	if (updateId === null) {
		logger.info("Telegram webhook update missing numeric update_id", {});
		return new Response("ok", { status: 200 });
	}

	const admin = createSupabaseAdminClient();

	// (2) Dedupe. INSERT ... ON CONFLICT DO NOTHING; a repeat yields zero rows.
	const { data: insertedUpdate, error: dedupeError } = await admin
		.from("telegram_updates")
		.upsert({ update_id: updateId }, { onConflict: "update_id", ignoreDuplicates: true })
		.select("update_id")
		.maybeSingle();
	if (dedupeError) {
		logger.error(
			"Telegram webhook dedupe insert failed",
			{ updateId },
			createErrorForLogging(dedupeError),
		);
		// Surface as non-2XX so Telegram retries — we never processed this update.
		return new Response("error", { status: 500 });
	}
	if (!insertedUpdate) {
		// Already seen — no-op, do NOT reprocess.
		logger.info("Telegram webhook ignoring duplicate update", { updateId });
		return new Response("ok", { status: 200 });
	}

	try {
		await processUpdate(update, admin, logger);
	} catch (error) {
		logger.error("Telegram webhook processing error", { updateId }, createErrorForLogging(error));
		// Already deduped; return 2XX so Telegram does not retry a poison update.
	}

	return new Response("ok", { status: 200 });
};

async function processUpdate(
	update: TelegramUpdate,
	admin: ReturnType<typeof createSupabaseAdminClient>,
	logger: ReturnType<typeof createLogger>,
): Promise<void> {
	const message = update.message;
	const text = typeof message?.text === "string" ? message.text : null;
	const chatId = typeof message?.chat?.id === "number" ? message.chat.id : null;
	const fromId = typeof message?.from?.id === "number" ? message.from.id : null;

	if (text === null || chatId === null || fromId === null) {
		// Non-message updates (edited messages, callbacks, etc.) are out of scope here.
		return;
	}

	const { isStart, payload } = parseStartCommand(text);
	if (!isStart) {
		return;
	}

	if (payload === null) {
		await reply(
			chatId,
			"Open your StockTextAlerts dashboard and tap Connect Telegram to link your account.",
		);
		return;
	}

	const verified = verifyLinkToken(payload);
	if (verified === null) {
		logger.info("Telegram /start rejected: invalid token signature", { chatId });
		await reply(chatId, "That link is invalid. Generate a fresh link from your dashboard.");
		return;
	}

	// (3) Atomic single-use consume: ONE conditional UPDATE. Filtering on
	// consumed_at IS NULL + expires_at > now() and RETURNING user_id means exactly
	// one caller can win, with no read-then-write race and no fail-open if the row
	// is missing (a missing/expired/consumed nonce simply returns zero rows).
	const nowIso = new Date().toISOString();
	const { data: consumed, error: consumeError } = await admin
		.from("telegram_link_tokens")
		.update({ consumed_at: nowIso })
		.eq("nonce", verified.nonce)
		.is("consumed_at", null)
		.gt("expires_at", nowIso)
		.select("user_id")
		.maybeSingle();

	if (consumeError) {
		logger.error(
			"Telegram link token consume failed",
			{ chatId },
			createErrorForLogging(consumeError),
		);
		await reply(
			chatId,
			"Something went wrong linking your account. Try again from your dashboard.",
		);
		return;
	}
	if (!consumed) {
		logger.info("Telegram /start rejected: link expired or already used", { chatId });
		await reply(
			chatId,
			"That link has expired or was already used. Generate a fresh link from your dashboard.",
		);
		return;
	}

	// Link the chat to the TOKEN's user_id — the signed subject — never from.id.
	const { error: linkError } = await admin
		.from("users")
		.update({
			telegram_chat_id: chatId,
			telegram_id: fromId,
			telegram_linked_at: nowIso,
			telegram_opted_out: false,
		})
		.eq("id", consumed.user_id);

	if (linkError) {
		logger.error(
			"Telegram link user update failed",
			{ userId: consumed.user_id, chatId },
			createErrorForLogging(linkError),
		);
		await reply(
			chatId,
			"Something went wrong linking your account. Try again from your dashboard.",
		);
		return;
	}

	logger.info("Telegram account linked", { userId: consumed.user_id });
	await reply(
		chatId,
		"Your Telegram is now linked to StockTextAlerts. You'll receive your alerts here.",
	);
}

/**
 * Best-effort confirmation reply. Never throws into the webhook handler — a
 * failed reply must not turn a successful link into a non-2XX (which would make
 * Telegram retry the now-consumed update).
 *
 * Routed through `createTelegramSender`, which has a hard `!isProduction()`
 * delivery gate: tests and dev get a deterministic mock and never hit the real
 * Telegram API, even if a bot token is present in the environment.
 */
async function reply(chatId: number, text: string): Promise<void> {
	try {
		const sender = createTelegramSender(createTelegramBot(readTelegramBotToken()));
		await sender({ chatId, text });
	} catch {
		// Swallow: the link state is already persisted; the user can re-open the bot.
	}
}
