/**
 * Read-only Telegram bot health check — reusable across the live-provider-check
 * Lambda and any future caller.
 *
 * Calls only read-only Bot-API methods:
 *   - getMe()          — confirms the token is valid and surfaces the bot's @username.
 *   - getWebhookInfo() — surfaces the registered webhook URL, pending update backlog,
 *                        and the most recent delivery error (if any).
 *
 * It NEVER calls sendMessage/sendPhoto/setWebhook/deleteWebhook — there is no live
 * test tier for Telegram (real chats = real delivery), so this is side-effect-free
 * and safe to run as a standing live check (it cannot mutate state or message a user).
 *
 * The result-shaping (`shapeHealthReport`) is pure and exported so a unit test can
 * exercise it with a transformer-mocked bot (no real network in the suite).
 */
import type { Bot } from "grammy";
import type { UserFromGetMe, WebhookInfo } from "grammy/types";

/** The flattened, human-readable health report assembled from the two API reads. */
interface TelegramHealthReport {
	ok: boolean;
	botId: number;
	username: string;
	/** Empty string when no webhook is registered. */
	webhookUrl: string;
	pendingUpdateCount: number;
	/** Most recent webhook delivery error message, or null if there is none. */
	lastError: string | null;
}

/**
 * Shape the two read-only API responses into a flat report. Pure — no I/O — so it
 * is unit-testable with a transformer-mocked bot. `ok` is true when the token
 * resolved to a bot (getMe returned an id); webhook fields are informational.
 */
export function shapeHealthReport(me: UserFromGetMe, webhook: WebhookInfo): TelegramHealthReport {
	return {
		ok: Number.isFinite(me.id) && me.id > 0,
		botId: me.id,
		username: me.username,
		webhookUrl: webhook.url ?? "",
		pendingUpdateCount: webhook.pending_update_count,
		lastError: webhook.last_error_message ?? null,
	};
}

/** Run both read-only probes against `bot` and return the shaped report. */
export async function checkTelegramLive(bot: Bot): Promise<TelegramHealthReport> {
	const [me, webhook] = await Promise.all([bot.api.getMe(), bot.api.getWebhookInfo()]);
	return shapeHealthReport(me, webhook);
}
