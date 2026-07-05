import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import {
	deliverTelegramPriceAlert,
	formatPriceAlertTelegram,
	type TelegramPriceAlert,
} from "../../../../src/lib/messaging/telegram/price-alert";
import type { TelegramMessage, TelegramSender } from "../../../../src/lib/messaging/types";
import type { EnrichedAlert } from "../../../../src/lib/price-alerts/types";
import type { ChannelDeliveryStats, IntradayCandle } from "../../../../src/lib/types";
import { dashboardButtonUrl } from "../../../helpers/messaging-doubles";

function makeAlert(overrides: Partial<EnrichedAlert> = {}): EnrichedAlert {
	return {
		symbol: "LDOS",
		priceMove: { symbol: "LDOS", changePercent: -11.1, price: 173.0, period: "today" },
		intradayCloses: null,
		intradayTimestamps: null,
		intradayEndTimestamp: null,
		intradayCandles: null,
		prevClose: 194.42,
		isPositiveMove: false,
		...overrides,
	};
}

/** Build a rising intraday candle series of `count` 5-minute bars. */
function makeCandles(count: number, start = 170): IntradayCandle[] {
	const base = Date.UTC(2026, 5, 19, 14, 35);
	return Array.from({ length: count }, (_, i) => {
		const o = start + i;
		return { o, h: o + 1.2, l: o - 0.8, c: o + 0.6, t: base + i * 5 * 60_000 };
	});
}

describe("A price-move alert is rendered for Telegram with entity formatting and a candlestick chart", () => {
	it("bolds the ticker, carries the price/change line, and produces a PNG when there are ≥2 candles", async () => {
		const result: TelegramPriceAlert = await formatPriceAlertTelegram(makeAlert(), makeCandles(6));

		expect(result.text).toContain("LDOS");
		expect(result.text).toContain("down 11.1% today ($173.00)");

		// Formatting travels out-of-band as entities (no MarkdownV2/HTML escaping).
		expect(result.entities.length).toBeGreaterThan(0);
		expect(result.entities.some((e) => e.type === "bold")).toBe(true);

		// A real PNG buffer is rasterized from the candlestick SVG.
		expect(result.photo).toBeInstanceOf(Buffer);
		expect((result.photo as Buffer).length).toBeGreaterThan(0);
		// PNG magic number: 0x89 'P' 'N' 'G'.
		expect((result.photo as Buffer).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("degrades to a text-only message (no photo, no throw) when there are too few candles", async () => {
		const empty = await formatPriceAlertTelegram(makeAlert(), []);
		expect(empty.photo).toBeNull();
		expect(empty.text).toContain("LDOS");

		const single = await formatPriceAlertTelegram(makeAlert(), makeCandles(1));
		expect(single.photo).toBeNull();
		expect(single.text).toContain("LDOS");
	});
});

/** Minimal supabase double: notification_log insert succeeds; nothing else is touched
 *  on a successful, non-bot-blocked send. */
function makeInsertOnlySupabase(): AppSupabaseClient {
	return {
		from() {
			return { insert: async () => ({ error: null }) };
		},
	} as unknown as AppSupabaseClient;
}

function makeStats(): ChannelDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
}

describe("deliverTelegramPriceAlert attaches the 'Manage notifications' dashboard button", () => {
	it("rides the candlestick sendPhoto path with a Market-Notifications deep link", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({
			success: true,
			messageSid: "tg-alert-1",
		}));

		const delivered = await deliverTelegramPriceAlert({
			alert: makeAlert({ intradayCandles: makeCandles(6) }),
			user: { id: "user-1", telegram_chat_id: 4242 },
			sendTelegram,
			supabase: makeInsertOnlySupabase(),
			stats: makeStats(),
		});

		expect(delivered).toBe(true);
		const sent = sendTelegram.mock.calls[0]?.[0] as TelegramMessage;
		// A candlestick PNG is present, so the button rides the sendPhoto path.
		expect(sent.photo).toBeInstanceOf(Buffer);
		expect(dashboardButtonUrl(sent)).toContain("#market-notifications");
	});

	it("rides the text fallback (no photo) with the same deep link", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));

		await deliverTelegramPriceAlert({
			alert: makeAlert({ intradayCandles: [] }),
			user: { id: "user-2", telegram_chat_id: 4343 },
			sendTelegram,
			supabase: makeInsertOnlySupabase(),
			stats: makeStats(),
		});

		const sent = sendTelegram.mock.calls[0]?.[0] as TelegramMessage;
		expect(sent.photo).toBeUndefined();
		expect(dashboardButtonUrl(sent)).toContain("#market-notifications");
	});
});
