import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import { buildTelegramPriceFooter } from "../../../../src/lib/messaging/parts/footer";
import { hasUnrenderedMarkdownLink } from "../../../../src/lib/messaging/parts/markdown-links";
import {
	deliverTelegramPriceAlert,
	formatPriceAlertTelegram,
	type TelegramPriceAlert,
} from "../../../../src/lib/messaging/telegram/price-alert";
import type { TelegramMessage, TelegramSender } from "../../../../src/lib/messaging/types";
import type { EnrichedAlert } from "../../../../src/lib/price-alerts/types";
import type { ChannelDeliveryStats, IntradayCandle } from "../../../../src/lib/types";
import { dashboardButtonUrl, inlineKeyboardButtonUrl } from "../../../helpers/messaging-doubles";

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
		expect(result.text).toContain(buildTelegramPriceFooter());
		// Delay disclosure is footer fine-print, not under the headline.
		expect(result.text.indexOf("down 11.1%")).toBeLessThan(
			result.text.indexOf("Prices delayed up to 15 minutes."),
		);

		// Formatting travels out-of-band as entities (no MarkdownV2/HTML escaping).
		expect(result.entities.length).toBeGreaterThan(0);
		expect(result.entities.some((e) => e.type === "bold")).toBe(true);

		// A real PNG buffer is rasterized from the candlestick SVG.
		expect(result.kind).toBe("photo");
		if (result.kind !== "photo") throw new Error("expected photo");
		expect(result.photo).toBeInstanceOf(Buffer);
		expect(result.photo.length).toBeGreaterThan(0);
		// PNG magic number: 0x89 'P' 'N' 'G'.
		expect(result.photo.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("degrades to a text-only message (no photo, no throw) when there are too few candles", async () => {
		const empty = await formatPriceAlertTelegram(makeAlert(), []);
		expect(empty.kind).toBe("text");
		expect(empty.text).toContain("LDOS");

		const single = await formatPriceAlertTelegram(makeAlert(), makeCandles(1));
		expect(single.kind).toBe("text");
		expect(single.text).toContain("LDOS");
	});

	it("inserts a why blurb after the headline and before the footer", async () => {
		const why = "Still the same story: Guidance optimism remains the driver.";
		const result = await formatPriceAlertTelegram(makeAlert({ why }), []);
		expect(result.text).toContain(why);
		const whyIdx = result.text.indexOf(why);
		const headlineIdx = result.text.indexOf("down 11.1%");
		const footerIdx = result.text.indexOf(buildTelegramPriceFooter());
		expect(whyIdx).toBeGreaterThan(headlineIdx);
		expect(whyIdx).toBeLessThan(footerIdx);
		expect(result.text.endsWith(buildTelegramPriceFooter())).toBe(true);
	});

	it("renders the lede only — no grade or packet internals", async () => {
		const result = await formatPriceAlertTelegram(
			makeAlert({ why: "Leidos slipped after a contract protest was filed." }),
			[],
		);
		expect(result.text).toContain("Leidos slipped after a contract protest was filed.");
		for (const token of ["confirmed", "reported", "narrative", "unexplained", "grade"]) {
			expect(result.text.toLowerCase()).not.toContain(token);
		}
		expect(result.text).not.toContain("catalyst_type");
		expect(result.text).not.toContain("move_onset");
	});

	it("never shows unrendered markdown links in final Telegram copy", async () => {
		const why =
			"PLTR shares rose 5.1% in after-hours trading after the company reported Q4 2025 results that beat estimates on revenue ($1.41B vs. $1.34B expected) and adjusted EPS ($0.25 vs. $0.23), alongside strong 2026 guidance projecting over 60% revenue growth.[[Yahoo Finance]](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)";
		const result = await formatPriceAlertTelegram(makeAlert({ symbol: "PLTR", why }), []);

		expect(hasUnrenderedMarkdownLink(result.text)).toBe(false);
		expect(result.text).toContain("Yahoo Finance");
		expect(result.text).not.toContain("[Yahoo Finance]");
		expect(result.text).not.toContain("[[Yahoo Finance]]");
		expect(result.text).not.toContain("](https://");
		expect(result.entities.some((e) => e.type === "text_link")).toBe(true);
		const link = result.entities.find((e) => e.type === "text_link");
		expect(link && "url" in link ? link.url : null).toBe(
			"https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html",
		);
	});

	it("truncates or drops why rather than exceeding the photo caption limit", async () => {
		const hugeWhy = `Update: ${"x".repeat(1200)}`;
		const result = await formatPriceAlertTelegram(makeAlert({ why: hugeWhy }), makeCandles(6));
		expect(result.kind).toBe("photo");
		expect(result.text.length).toBeLessThanOrEqual(1024);
		// Still delivers the alert body even if why had to be dropped/truncated.
		expect(result.text).toContain("LDOS");
		expect(result.text).toContain("down 11.1%");
	});

	it("never leaves unrendered markdown when a long why with a trailing citation is truncated", async () => {
		const why = `${"x".repeat(900)} growth.[[Yahoo Finance]](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)`;
		const result = await formatPriceAlertTelegram(makeAlert({ why }), makeCandles(6));
		expect(result.kind).toBe("photo");
		expect(result.text.length).toBeLessThanOrEqual(1024);
		expect(hasUnrenderedMarkdownLink(result.text)).toBe(false);
		expect(result.text).not.toContain("](https://");
		expect(result.text).toContain(buildTelegramPriceFooter());
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
		expect(sent.kind).toBe("photo");
		if (sent.kind !== "photo") throw new Error("expected photo");
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
		expect(sent.kind).toBe("text");
		expect(dashboardButtonUrl(sent)).toContain("#market-notifications");
	});

	it("adds a Full report button above Manage notifications when a report URL is set", async () => {
		const sendTelegram = vi.fn<TelegramSender>(async () => ({ success: true }));
		const reportUrl = "http://localhost/dashboard/price-move/LDOS";

		await deliverTelegramPriceAlert({
			alert: makeAlert({ intradayCandles: [] }),
			user: { id: "user-3", telegram_chat_id: 4444 },
			sendTelegram,
			supabase: makeInsertOnlySupabase(),
			stats: makeStats(),
			fullReportUrl: reportUrl,
		});

		const sent = sendTelegram.mock.calls[0]?.[0] as TelegramMessage;
		expect(inlineKeyboardButtonUrl(sent, "Full report")).toBe(reportUrl);
		expect(inlineKeyboardButtonUrl(sent, "⚙️ Manage notifications")).toContain(
			"#market-notifications",
		);
	});
});
