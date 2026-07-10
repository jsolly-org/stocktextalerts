import { describe, expect, it } from "vitest";
import { formatAssetEventsTelegram } from "../../../../src/lib/messaging/notifications/asset-events";

describe("Telegram asset-events formatting", () => {
	it("bolds space-suffixed IPO tickers in section bodies", () => {
		const msg = formatAssetEventsTelegram({
			earningsSection: null,
			dividendsSection: null,
			splitsSection: null,
			iposSection: "SKHY V: IPO tomorrow — SK Hynix Inc",
			analystSection: null,
			insiderSection: null,
		});

		expect(msg.text).toContain("SKHY V: IPO tomorrow — SK Hynix Inc");
		const boldTexts = msg.entities
			.filter((e) => e.type === "bold")
			.map((e) => msg.text.slice(e.offset, e.offset + e.length));
		expect(boldTexts).toContain("SKHY V:");
	});
});
