/**
 * Idempotently register the Telegram bot's command menu (the "/" autocomplete list).
 *
 * Decoupled from `telegram-set-webhook.ts` on purpose: the command menu needs ONLY
 * the bot token — no webhook URL, no secret — so it runs cleanly from a laptop with
 * just TELEGRAM_BOT_TOKEN in the env. (The webhook script derives its URL from
 * SITE_URL, which is a dev/localhost value locally, so folding commands into it would
 * gate this rare, safe operation behind a webhook re-point that fails off-HTTPS.)
 *
 * Usage (human-run, requires only the bot token in the env):
 *   npm run telegram:set-commands            # set on drift only
 *   npm run telegram:set-commands -- --force # always re-send
 *
 * Idempotency: compares `getMyCommands` and only calls `setMyCommands` on drift.
 */
import type { BotCommand } from "grammy/types";
import { createTelegramBot, readTelegramBotToken } from "../src/lib/messaging/telegram/sender";

/**
 * The bot's command menu (the "/" autocomplete list). Mirrors the commands the
 * webhook handler acts on (`/start` is the deep-link entry point, deliberately
 * omitted from the discoverable menu). Kept in sync with HELP_TEXT in
 * `src/pages/api/messaging/telegram.ts`.
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

async function main(): Promise<void> {
	const force = new Set(process.argv.slice(2)).has("--force");
	const bot = createTelegramBot(readTelegramBotToken());

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
	process.stderr.write(
		`telegram:set-commands failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
