import { describe, expect, it } from "vitest";
import {
	needsNotificationChannelSelection,
	resolveOutboundChannel,
	wantsEmailDelivery,
	wantsTelegramDelivery,
} from "../../../src/lib/messaging/delivery-channel";
import { createTelegramSenderFactory } from "../../../src/lib/messaging/telegram/sender-factory";

describe("account delivery routing", () => {
	it("resolves email when delivery_channel is email", () => {
		expect(resolveOutboundChannel({ delivery_channel: "email", telegram_chat_id: null })).toBe(
			"email",
		);
		expect(wantsEmailDelivery({ delivery_channel: "email" })).toBe(true);
		expect(wantsEmailDelivery({ delivery_channel: "telegram" })).toBe(false);
	});

	it("resolves telegram only when routed to telegram AND linked", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "telegram",
				telegram_chat_id: 8675309,
			}),
		).toBe("telegram");
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: 8675309,
				delivery_channel: "telegram",
			}),
		).toBe(true);
	});

	it("returns null when telegram is selected but chat is not linked", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "telegram",
				telegram_chat_id: null,
			}),
		).toBeNull();
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: null,
				delivery_channel: "telegram",
			}),
		).toBe(false);
	});

	it("returns null when delivery_channel is disabled", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "disabled",
				telegram_chat_id: 8675309,
			}),
		).toBeNull();
		expect(wantsEmailDelivery({ delivery_channel: "disabled" })).toBe(false);
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: 8675309,
				delivery_channel: "disabled",
			}),
		).toBe(false);
	});
});

describe("needsNotificationChannelSelection (dashboard setup gate)", () => {
	it("does not warn when delivery_channel is email", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "email" })).toBe(false);
	});

	it("does not warn when delivery_channel is telegram", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "telegram" })).toBe(false);
	});

	it("warns when delivery_channel is disabled", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "disabled" })).toBe(true);
	});
});

describe("Telegram sender factory gate", () => {
	it("in test mode the factory returns the deterministic mock, never the real bot", async () => {
		const { sender } = createTelegramSenderFactory()();
		const result = await sender({
			kind: "text",
			chatId: 8675309,
			text: "AAPL daily digest: up 1.2%",
		});
		expect(result).toMatchObject({ success: true, messageSid: "mock" });
	});
});
