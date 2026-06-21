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
 *
 * `checkTelegramLive` is bounded by a hard timeout: a Telegram API call that stalls
 * (the Lambda→api.telegram.org reachability problem under investigation — see
 * `createTelegramBot`) must fail loudly and fast so the alarm carries a useful
 * message, not burn the whole invocation in a silent hang.
 */
import type { Bot } from "grammy";
import type { UserFromGetMe, WebhookInfo } from "grammy/types";

/** Default ceiling for the two read-only probes before the check fails loudly. */
const DEFAULT_TIMEOUT_MS = 12_000;

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

/**
 * Run both read-only probes against `bot`, bounded by `timeoutMs`, and return the
 * shaped report. If the probes don't settle in time the returned promise rejects
 * with a clear, attributable error — the caller maps that to a failed check so the
 * alarm says "Telegram health check timed out", not just "Lambda timed out". grammY's
 * own request timeout (set low in `createTelegramBot`) should abort first; this race
 * is the backstop for the case where that abort itself wedges.
 */
export async function checkTelegramLive(
	bot: Bot,
	{ timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<TelegramHealthReport> {
	const probes = Promise.all([bot.api.getMe(), bot.api.getWebhookInfo()]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Telegram health check timed out after ${timeoutMs} ms`)),
			timeoutMs,
		);
	});
	try {
		const [me, webhook] = await Promise.race([probes, timeout]);
		return shapeHealthReport(me, webhook);
	} finally {
		clearTimeout(timer);
	}
}
