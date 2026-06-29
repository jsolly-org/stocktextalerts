import { describe, expect, it } from "vitest";
import { enabledFacets, type PrefRow } from "../../../src/lib/messaging/notification-prefs";
import {
	isTelegramChannelUsable,
	shouldSendTelegram,
} from "../../../src/lib/messaging/telegram/eligibility";
import { createTelegramSenderFactory } from "../../../src/lib/messaging/telegram/sender-factory";

const digestPrefs: PrefRow[] = [
	{
		notification_type: "daily_notification",
		content: "prices",
		channel: "telegram",
		enabled: true,
	},
	{ notification_type: "daily_notification", content: "news", channel: "telegram", enabled: false },
	{
		notification_type: "daily_notification",
		content: "top_movers",
		channel: "telegram",
		enabled: true,
	},
	{
		notification_type: "daily_notification",
		content: "calendar",
		channel: "telegram",
		enabled: true,
	},
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
		const facets = enabledFacets(digestPrefs, "daily_notification", "telegram");
		expect(facets).toEqual(new Set(["prices", "top_movers", "calendar"]));
	});

	it("a linked user with at least one enabled digest facet should receive the digest", () => {
		const user = { telegram_chat_id: 8675309, telegram_opted_out: false };
		expect(shouldSendTelegram(user, digestPrefs, "daily_notification")).toBe(true);
	});

	it("a linked user with every facet disabled should NOT receive the digest", () => {
		const user = { telegram_chat_id: 8675309, telegram_opted_out: false };
		const allOff = digestPrefs.map((p) => ({ ...p, enabled: false }));
		expect(shouldSendTelegram(user, allOff, "daily_notification")).toBe(false);
	});
});

describe("Telegram sender factory gate", () => {
	it("in test mode the factory returns the deterministic mock, never the real bot", async () => {
		const { sender } = createTelegramSenderFactory()();
		const result = await sender({ chatId: 8675309, text: "AAPL daily digest: up 1.2%" });
		expect(result).toMatchObject({ success: true, messageSid: "mock" });
	});
});
