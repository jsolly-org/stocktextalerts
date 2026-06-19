/**
 * GATED live-send integration test — actually delivers to a real Telegram chat.
 *
 * DEFAULT-SKIPPED. It runs ONLY when BOTH of these env vars are set:
 *   TELEGRAM_LIVE_TEST=1
 *   TELEGRAM_LIVE_TEST_CHAT_ID=<numeric chat id to receive the messages>
 * and it reads the REAL bot credential from TELEGRAM_BOT_TOKEN.
 *
 * How to run (NEVER point this at a real user's chat):
 *   1. Create a dedicated test chat, or use Telegram's isolated test environment
 *      (https://core.telegram.org/bots/webapps#testing-mini-apps) with a test-DC
 *      bot, so a stray message can't reach a subscriber.
 *   2. Get that chat's numeric id (e.g. message @RawDataBot, or read it from your
 *      own getUpdates).
 *   3. Export the creds and run:
 *        TELEGRAM_BOT_TOKEN=<token> \
 *        TELEGRAM_LIVE_TEST=1 \
 *        TELEGRAM_LIVE_TEST_CHAT_ID=<chat id> \
 *        npm run test:live:telegram
 *
 * Why gated: Telegram has no mock/live tier the way prices do — a real send is a
 * real message to a real chat (the 2026-04-11 real-delivery incident class). The
 * default `npm test` must stay mock-only and CI-safe, so this file no-ops unless
 * you deliberately opt in with the two env vars above.
 */
import { describe, expect, it } from "vitest";
import {
	buildCandlestickSvg,
	type Candle,
	renderChartPng,
} from "../../src/lib/messaging/telegram/chart";
import {
	createTelegramBot,
	readTelegramBotToken,
	sendViaBot,
} from "../../src/lib/messaging/telegram/sender";

const liveEnabled =
	process.env.TELEGRAM_LIVE_TEST === "1" &&
	typeof process.env.TELEGRAM_LIVE_TEST_CHAT_ID === "string" &&
	process.env.TELEGRAM_LIVE_TEST_CHAT_ID.trim() !== "";

/** Numeric chat id to receive the live messages (validated in the gate above). */
function liveChatId(): number {
	const raw = (process.env.TELEGRAM_LIVE_TEST_CHAT_ID ?? "").trim();
	const id = Number(raw);
	if (!Number.isFinite(id)) {
		throw new Error(`TELEGRAM_LIVE_TEST_CHAT_ID is not numeric: ${raw}`);
	}
	return id;
}

/** A small rising intraday candle series, mirroring the price-alert test fixture. */
function makeCandles(count: number, start = 170): Candle[] {
	const base = Date.UTC(2026, 5, 19, 14, 35);
	return Array.from({ length: count }, (_, i) => {
		const o = start + i;
		return { o, h: o + 1.2, l: o - 0.8, c: o + 0.6, t: base + i * 5 * 60_000 };
	});
}

describe.skipIf(!liveEnabled)("Telegram live send (opt-in: TELEGRAM_LIVE_TEST=1 + chat id)", () => {
	it("delivers a real text message and returns a numeric message_id", async () => {
		const bot = createTelegramBot(readTelegramBotToken());
		const result = await sendViaBot(bot, {
			chatId: liveChatId(),
			text: `StockTextAlerts live-send test (text) — ${new Date().toISOString()}`,
			entities: [{ type: "bold", offset: 0, length: 14 }],
			disableNotification: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(Number(result.messageSid)).toBeGreaterThan(0);
		}
	});

	it("delivers a real candlestick-chart photo and returns a numeric message_id", async () => {
		const svg = buildCandlestickSvg(makeCandles(6), { prevClose: 169 });
		const photo = renderChartPng(svg);
		expect(photo).toBeInstanceOf(Buffer);

		const bot = createTelegramBot(readTelegramBotToken());
		const result = await sendViaBot(bot, {
			chatId: liveChatId(),
			text: `StockTextAlerts live-send test (chart) — ${new Date().toISOString()}`,
			photo: photo as Buffer,
			disableNotification: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(Number(result.messageSid)).toBeGreaterThan(0);
		}
	});
});
