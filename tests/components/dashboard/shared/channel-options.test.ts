import { describe, expect, it } from "vitest";
import {
	getEmailChannelDisabledTitle,
	getTelegramChannelDisabledTitle,
} from "../../../../src/components/dashboard/shared/channel-options";

describe("channel option disabled titles", () => {
	it("email title is set only when email is off", () => {
		expect(getEmailChannelDisabledTitle(true)).toBeUndefined();
		expect(getEmailChannelDisabledTitle(false)).toMatch(/Enable email/i);
	});

	it("Telegram title is unset when the channel is usable", () => {
		expect(
			getTelegramChannelDisabledTitle({
				telegram_chat_id: 8675309,
				telegram_opted_out: false,
			}),
		).toBeUndefined();
	});

	it("Telegram title asks to connect when unlinked", () => {
		expect(
			getTelegramChannelDisabledTitle({
				telegram_chat_id: null,
				telegram_opted_out: false,
			}),
		).toMatch(/Connect Telegram/i);
	});

	it("Telegram title asks to unblock when opted out", () => {
		expect(
			getTelegramChannelDisabledTitle({
				telegram_chat_id: 8675309,
				telegram_opted_out: true,
			}),
		).toMatch(/Unblock/i);
	});
});
