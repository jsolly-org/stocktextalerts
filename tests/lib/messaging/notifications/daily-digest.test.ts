import { describe, expect, it } from "vitest";
import { formatDailyDigestTelegram } from "../../../../src/lib/messaging/notifications/daily-digest";
import type { AssetPriceMap } from "../../../../src/lib/types";

describe("Telegram daily digest formatting", () => {
	it("renders a multi-asset digest with entities, color dots, and the /stop hint (no disclaimer)", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 228.5, changePercent: 2.5 }],
			["TSLA", { price: 410.12, changePercent: -1.8 }],
		]);
		const msg = formatDailyDigestTelegram({
			userAssets: [
				{ symbol: "AAPL", name: "Apple Inc." },
				{ symbol: "TSLA", name: "Tesla Inc." },
			],
			assetPrices,
			extras: { news: "Apple unveils a new in-house modem chip." },
			dateLabel: "Thu, Jun 19",
		});

		expect(msg.text).toContain("Daily Digest · Thu, Jun 19");
		expect(msg.text).toContain("🟢 AAPL");
		expect(msg.text).toContain("$228.50");
		expect(msg.text).toContain("(+2.50%)");
		expect(msg.text).toContain("🔴 TSLA");
		expect(msg.text).toContain("(-1.80%)");
		expect(msg.text).toContain("Apple unveils a new in-house modem chip.");
		// Personal-app footer: no "not financial advice" disclaimer; Telegram keeps the
		// actionable /stop hint.
		expect(msg.text.toLowerCase()).not.toContain("financial advice");
		expect(msg.text).toContain("/stop");

		// Entities travel out-of-band (no escaping): bold header/tickers + a news blockquote.
		expect(msg.entities.length).toBeGreaterThan(0);
		expect(msg.entities.some((e) => e.type === "bold")).toBe(true);
		expect(msg.entities.some((e) => e.type === "blockquote")).toBe(true);
	});

	it("renders the delay banner under the header, matching email/SMS (was Telegram-omitted)", () => {
		const msg = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: {},
			dateLabel: "Thu, Jun 19",
			delayBanner: "⏱️ Sent 7 min late due to a delay.",
		});

		expect(msg.text).toContain("⏱️ Sent 7 min late due to a delay.");
		// Banner sits between the header and the first asset line.
		const headerIdx = msg.text.indexOf("Daily Digest");
		const bannerIdx = msg.text.indexOf("Sent 7 min late");
		const assetIdx = msg.text.indexOf("AAPL");
		expect(headerIdx).toBeLessThan(bannerIdx);
		expect(bannerIdx).toBeLessThan(assetIdx);
	});

	it("omits sections that have no content", () => {
		const msg = formatDailyDigestTelegram({
			userAssets: [{ symbol: "NVDA", name: "NVIDIA" }],
			assetPrices: new Map([["NVDA", { price: 1200, changePercent: 0 }]]),
			extras: {},
			dateLabel: "Fri, Jun 20",
		});
		expect(msg.text).toContain("⚪️ NVDA");
		expect(msg.text).not.toContain("News");
		expect(msg.text).not.toContain("Rumors");
		expect(msg.text).not.toContain("Top movers");
	});
});
