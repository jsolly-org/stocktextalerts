/**
 * Idempotently point the Telegram bot webhook at our endpoint AND register the
 * bot's command menu (`setMyCommands`).
 *
 * Usage (human-run, requires the bot token + webhook secret in the env):
 *   npm run telegram:set-webhook            # set on drift only
 *   npm run telegram:set-webhook -- --force # always re-send (e.g. secret rotation)
 *   npm run telegram:set-webhook -- --delete # tear the webhook down (dev/teardown)
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      — the bot credential (write).
 *   TELEGRAM_WEBHOOK_SECRET — sent as `secret_token`; Telegram echoes it back in
 *                             the `X-Telegram-Bot-Api-Secret-Token` header.
 *   TELEGRAM_WEBHOOK_URL    — explicit webhook URL (preferred), else derived from
 *                             SITE_URL as `<SITE_URL>/api/messaging/telegram`.
 *
 * Idempotency: `getWebhookInfo` returns the currently-registered `url` (Telegram
 * never returns the secret). We compare the URL and only call `setWebhook` when
 * it drifts. The secret cannot be read back, so rotate it with `--force`.
 */
import type { BotCommand } from "grammy/types";
import { createTelegramBot, readTelegramBotToken } from "../src/lib/messaging/telegram/sender";
import { getSiteUrl, readEnv, requireEnv } from "../src/lib/db/env";

const WEBHOOK_PATH = "/api/messaging/telegram";

/**
 * The bot's command menu (the "/" autocomplete list). Mirrors the commands the
 * webhook handler acts on (`/start` is the deep-link entry point, deliberately
 * omitted from the discoverable menu). Kept in sync with HELP_TEXT.
 */
const BOT_COMMANDS: BotCommand[] = [
	{ command: "dashboard", description: "Open your notification dashboard" },
	{ command: "stop", description: "Pause Telegram alerts (keeps your account)" },
	{ command: "unlink", description: "Disconnect this chat from your account" },
	{ command: "help", description: "Show the list of commands" },
];

/** True when the live command menu already matches BOT_COMMANDS exactly (order included). */
function commandsMatch(current: readonly BotCommand[]): boolean {
	if (current.length !== BOT_COMMANDS.length) return false;
	return BOT_COMMANDS.every((want, i) => {
		const have = current[i];
		return have?.command === want.command && have?.description === want.description;
	});
}

function resolveWebhookUrl(): string {
	const explicit = readEnv("TELEGRAM_WEBHOOK_URL");
	if (explicit) {
		return explicit.trim();
	}
	const base = getSiteUrl().replace(/\/+$/, "");
	return `${base}${WEBHOOK_PATH}`;
}

async function main(): Promise<void> {
	const args = new Set(process.argv.slice(2));
	const force = args.has("--force");
	const remove = args.has("--delete");

	const bot = createTelegramBot(readTelegramBotToken());

	if (remove) {
		await bot.api.deleteWebhook();
		process.stdout.write("Telegram webhook deleted.\n");
		return;
	}

	const desiredUrl = resolveWebhookUrl();
	const secret = requireEnv("TELEGRAM_WEBHOOK_SECRET");

	const info = await bot.api.getWebhookInfo();
	const currentUrl = info.url ?? "";

	if (!force && currentUrl === desiredUrl) {
		process.stdout.write(`Telegram webhook already set to ${desiredUrl} — no change.\n`);
	} else {
		await bot.api.setWebhook(desiredUrl, { secret_token: secret });
		const reason = force ? "forced re-set" : `drift (was "${currentUrl || "<unset>"}")`;
		process.stdout.write(`Telegram webhook set to ${desiredUrl} (${reason}).\n`);
	}

	await syncCommands(bot, force);
}

/**
 * Idempotently register the bot's command menu. Like the webhook, compares the
 * live menu (getMyCommands) and only calls setMyCommands on drift (or --force).
 */
async function syncCommands(bot: ReturnType<typeof createTelegramBot>, force: boolean): Promise<void> {
	const current = await bot.api.getMyCommands();
	if (!force && commandsMatch(current)) {
		process.stdout.write("Telegram bot commands already up to date — no change.\n");
		return;
	}
	await bot.api.setMyCommands(BOT_COMMANDS);
	process.stdout.write(
		`Telegram bot commands set (${BOT_COMMANDS.map((c) => `/${c.command}`).join(", ")}).\n`,
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`telegram:set-webhook failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
