import { describe, expect, it } from "vitest";
import {
	enabledTelegramFacets,
	isTelegramChannelUsable,
	shouldSendTelegram,
	type TelegramPrefRow,
} from "../../../src/lib/messaging/telegram/eligibility";
import { createTelegramSenderProvider } from "../../../src/lib/schedule/telegram-sender";

const digestPrefs: TelegramPrefRow[] = [
	{ notification_type: "daily_digest", content: "prices", channel: "telegram", enabled: true },
	{ notification_type: "daily_digest", content: "news", channel: "telegram", enabled: false },
	{ notification_type: "daily_digest", content: "top_movers", channel: "telegram", enabled: true },
	{ notification_type: "asset_events", content: "calendar", channel: "telegram", enabled: true },
];

describe("Telegram delivery eligibility", () => {
	it("a linked user who has not opted out can receive Telegram messages", () => {
		expect(isTelegramChannelUsable({ telegram_chat_id: 8675309, telegram_opted_out: false })).toBe(
			true,
		);
	});

	it("an unlinked user (no chat id) cannot receive Telegram messages", () => {
		expect(isTelegramChannelUsable({ telegram_chat_id: null, telegram_opted_out: false })).toBe(
			false,
		);
	});

	it("a user who blocked the bot (opted out) cannot receive Telegram messages", () => {
		expect(isTelegramChannelUsable({ telegram_chat_id: 8675309, telegram_opted_out: true })).toBe(
			false,
		);
	});

	it("returns only the enabled facets for the requested notification type", () => {
		const facets = enabledTelegramFacets(digestPrefs, "daily_digest");
		expect(facets).toEqual(new Set(["prices", "top_movers"]));
		// 'news' is disabled and 'calendar' belongs to a different type — both excluded.
	});

	it("a linked user with at least one enabled digest facet should receive the digest", () => {
		const user = { telegram_chat_id: 8675309, telegram_opted_out: false };
		expect(shouldSendTelegram(user, digestPrefs, "daily_digest")).toBe(true);
	});

	it("a linked user with every facet disabled should NOT receive the digest", () => {
		const user = { telegram_chat_id: 8675309, telegram_opted_out: false };
		const allOff = digestPrefs.map((p) => ({ ...p, enabled: false }));
		expect(shouldSendTelegram(user, allOff, "daily_digest")).toBe(false);
	});
});

describe("Telegram sender provider gate", () => {
	it("in test mode the provider returns the deterministic mock, never the real bot", async () => {
		const { sender } = createTelegramSenderProvider()();
		const result = await sender({ chatId: 8675309, text: "AAPL daily digest: up 1.2%" });
		expect(result).toMatchObject({ success: true, messageSid: "mock" });
	});
});
