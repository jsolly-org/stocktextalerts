import { describe, expect, it } from "vitest";
import { createTelegramSenderFactory } from "../../../../src/lib/messaging/telegram/sender-factory";

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
