/**
 * Read-only Telegram bot health check — the `/ship` Telegram live-verification step.
 *
 * Usage (allowed for agents because it sends NOTHING):
 *   npm run telegram:health
 *
 * Calls only read-only Bot-API methods:
 *   - getMe()          — confirms the token is valid and logs the bot's @username.
 *   - getWebhookInfo() — logs the registered webhook URL, pending update backlog,
 *                        and the most recent delivery error (if any).
 *
 * It NEVER calls sendMessage/sendPhoto/setWebhook/deleteWebhook — there is no live
 * test tier for Telegram (real chats = real delivery), so this is the only
 * standing live action: it cannot mutate state or message a user. Exits non-zero
 * with a clear message if TELEGRAM_BOT_TOKEN is unset or getMe() fails.
 *
 * The result-shaping (`shapeHealthReport`) is pure and exported so a unit test can
 * exercise it with a transformer-mocked bot (no real network in the suite).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Bot } from "grammy";
import type { UserFromGetMe, WebhookInfo } from "grammy/types";
import { createTelegramBot, readTelegramBotToken } from "../../src/lib/messaging/telegram/sender";

/** The flattened, human-readable health report assembled from the two API reads. */
export interface TelegramHealthReport {
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
export async function runHealthCheck(bot: Bot): Promise<TelegramHealthReport> {
	const [me, webhook] = await Promise.all([bot.api.getMe(), bot.api.getWebhookInfo()]);
	return shapeHealthReport(me, webhook);
}

async function main(): Promise<void> {
	const bot = createTelegramBot(readTelegramBotToken());
	const report = await runHealthCheck(bot);

	process.stdout.write(
		`Telegram bot OK — @${report.username} (id ${report.botId}).\n` +
			`  webhook: ${report.webhookUrl || "<none set>"}\n` +
			`  pending updates: ${report.pendingUpdateCount}\n` +
			`  last webhook error: ${report.lastError ?? "<none>"}\n`,
	);

	if (!report.ok) {
		throw new Error("getMe() returned no bot id — token may be invalid.");
	}
}

// Only run when invoked as a script (`npm run telegram:health`), not when this
// module is imported by the unit test — which exercises shapeHealthReport /
// runHealthCheck with a transformer-mocked bot and no real token.
const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`telegram:health failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
