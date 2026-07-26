import { describe, expect, it } from "vitest";
import {
	getEmailChannelDisabledTitle,
	getTelegramChannelDisabledTitle,
} from "../../../../src/components/dashboard/shared/channel-options";

describe("Channel option disabled titles", () => {
	it("email title is empty when email is enabled", () => {
		expect(getEmailChannelDisabledTitle(true)).toBeUndefined();
	});

	it("email title prompts enabling the global email toggle when off", () => {
		expect(getEmailChannelDisabledTitle(false)).toBe(
			"Enable email in your notification channels to select this option.",
		);
	});

	it("telegram title is empty when linked and not opted out", () => {
		expect(
			getTelegramChannelDisabledTitle({ telegram_chat_id: 1, telegram_opted_out: false }),
		).toBeUndefined();
	});

	it("telegram title prompts connecting when unlinked", () => {
		expect(
			getTelegramChannelDisabledTitle({ telegram_chat_id: null, telegram_opted_out: false }),
		).toBe("Connect Telegram in your notification channels to select this option.");
	});

	it("telegram title prompts enabling the global toggle when opted out", () => {
		expect(getTelegramChannelDisabledTitle({ telegram_chat_id: 1, telegram_opted_out: true })).toBe(
			"Enable Telegram in your notification channels to select this option.",
		);
	});
});
