import { describe, expect, it } from "vitest";
import { formatDailyDigestTelegram } from "../../../../src/lib/messaging/notifications/daily-digest";
import {
	TELEGRAM_TEXT_MARGIN,
	TELEGRAM_TEXT_MAX_UTF16,
} from "../../../../src/lib/messaging/telegram/limits";
import type { AssetPriceMap } from "../../../../src/lib/types";

const textBudget = TELEGRAM_TEXT_MAX_UTF16 - TELEGRAM_TEXT_MARGIN;

function joinDigestText(chunks: ReturnType<typeof formatDailyDigestTelegram>): string {
	return chunks.map((chunk) => chunk.text).join("\n\n");
}

function expectTelegramEntitiesInRange(chunk: {
	text: string;
	entities: { offset: number; length: number }[];
}) {
	for (const entity of chunk.entities) {
		expect(entity.offset).toBeGreaterThanOrEqual(0);
		expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
	}
}

describe("Telegram daily digest formatting", () => {
	it("renders a multi-asset digest with entities, color dots, and the /stop hint (no disclaimer)", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 228.5, changePercent: 2.5 }],
			["TSLA", { price: 410.12, changePercent: -1.8 }],
		]);
		const chunks = formatDailyDigestTelegram({
			userAssets: [
				{ symbol: "AAPL", name: "Apple Inc." },
				{ symbol: "TSLA", name: "Tesla Inc." },
			],
			assetPrices,
			extras: { news: "Apple unveils a new in-house modem chip." },
			dateLabel: "Thu, Jun 19",
		});
		expect(chunks).toHaveLength(1);
		const msg = chunks[0];
		expect(msg).toBeDefined();
		if (msg === undefined) throw new Error("expected digest chunk");

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

	it("renders the delay banner under the header, matching email (was Telegram-omitted)", () => {
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: {},
			dateLabel: "Thu, Jun 19",
			delayBanner: "⏱️ Sent 7 min late due to a delay.",
		});
		expect(chunks).toHaveLength(1);
		const msg = chunks[0];
		expect(msg).toBeDefined();
		if (msg === undefined) throw new Error("expected digest chunk");

		expect(msg.text).toContain("⏱️ Sent 7 min late due to a delay.");
		// Banner sits between the header and the first asset line.
		const headerIdx = msg.text.indexOf("Daily Digest");
		const bannerIdx = msg.text.indexOf("Sent 7 min late");
		const assetIdx = msg.text.indexOf("AAPL");
		expect(headerIdx).toBeLessThan(bannerIdx);
		expect(bannerIdx).toBeLessThan(assetIdx);
	});

	it("omits sections that have no content", () => {
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "NVDA", name: "NVIDIA" }],
			assetPrices: new Map([["NVDA", { price: 1200, changePercent: 0 }]]),
			extras: {},
			dateLabel: "Fri, Jun 20",
		});
		expect(chunks).toHaveLength(1);
		const text = joinDigestText(chunks);
		expect(text).toContain("⚪️ NVDA");
		expect(text).not.toContain("News");
		expect(text).not.toContain("Rumors");
		expect(text).not.toContain("Top movers");
	});

	it("bolds top-mover and IPO tickers in Telegram entities", () => {
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: {
				topMovers: {
					gainers: [{ ticker: "JLHL", price: 12.79, changePercent: 586.27 }],
					losers: [],
				},
			},
			assetEvents: {
				eventsSection: {
					earnings: null,
					dividends: null,
					splits: null,
					ipos: "SKHY V: IPO tomorrow — SK Hynix Inc",
				},
				analystSection: null,
				insiderSection: null,
				filingsLines: null,
				shortInterest: null,
				hasAnyContent: true,
			},
			dateLabel: "Fri, Jul 10",
		});
		expect(chunks).toHaveLength(1);
		const msg = chunks[0];
		expect(msg).toBeDefined();
		if (msg === undefined) throw new Error("expected digest chunk");

		expect(msg.text).toContain("JLHL — $12.79");
		expect(msg.text).toContain("SKHY V: IPO tomorrow");
		const boldTexts = msg.entities
			.filter((e) => e.type === "bold")
			.map((e) => msg.text.slice(e.offset, e.offset + e.length));
		expect(boldTexts).toContain("JLHL");
		expect(boldTexts).toContain("SKHY V:");
	});

	it("preserves bold ticker entities inside news blockquotes", () => {
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: { news: "AAPL: First news line" },
			dateLabel: "Fri, Jul 10",
		});
		expect(chunks).toHaveLength(1);
		const msg = chunks[0];
		expect(msg).toBeDefined();
		if (msg === undefined) throw new Error("expected digest chunk");

		expect(msg.entities.some((e) => e.type === "blockquote")).toBe(true);
		const boldTexts = msg.entities
			.filter((e) => e.type === "bold")
			.map((e) => msg.text.slice(e.offset, e.offset + e.length));
		expect(boldTexts).toContain("AAPL:");
	});

	it("places Upcoming IPOs above Prediction Markets, with Prediction Markets last", () => {
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: {
				news: "AAPL: chip news",
				predictionMarkets: [
					{
						key: "fed",
						label: "Fed cut odds",
						venue: "kalshi",
						probabilityPercent: 42,
						deltaPoints: null,
						url: "https://example.com/fed",
					},
				],
			},
			assetEvents: {
				eventsSection: {
					earnings: "AAPL: earnings tomorrow",
					dividends: null,
					splits: null,
					ipos: "FOO: IPO Friday",
				},
				analystSection: null,
				insiderSection: null,
				filingsLines: null,
				shortInterest: null,
				hasAnyContent: true,
			},
			dateLabel: "Thu, Jul 30",
		});
		expect(chunks).toHaveLength(1);
		const text = joinDigestText(chunks);

		const newsIdx = text.indexOf("News");
		const earningsIdx = text.indexOf("Earnings");
		const iposIdx = text.indexOf("Upcoming IPOs");
		const pmIdx = text.indexOf("Prediction Markets");
		const footerIdx = text.indexOf("/stop");

		expect(newsIdx).toBeGreaterThanOrEqual(0);
		expect(earningsIdx).toBeGreaterThan(newsIdx);
		expect(iposIdx).toBeGreaterThan(earningsIdx);
		expect(pmIdx).toBeGreaterThan(iposIdx);
		expect(footerIdx).toBeGreaterThan(pmIdx);
	});

	it("packs an oversized News+Rumors digest into chunks under the Telegram text budget", () => {
		const news = Array.from(
			{ length: 12 },
			(_, i) => `AAPL: ${"n".repeat(220)} headline ${i}`,
		).join("\n\n");
		const rumors = Array.from(
			{ length: 12 },
			(_, i) => `TSLA: ${"r".repeat(220)} chatter ${i}`,
		).join("\n\n");
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: { news, rumors },
			dateLabel: "Fri, Aug 14",
		});
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(textBudget);
			expectTelegramEntitiesInRange(chunk);
		}
		const text = joinDigestText(chunks);
		expect(text).toContain("News");
		expect(text).toContain("Rumors");
		expect(text).toContain("/stop");
		expect(
			chunks.some((chunk) => chunk.entities.some((entity) => entity.type === "blockquote")),
		).toBe(true);
		const boldTickerChunks = chunks.flatMap((chunk) =>
			chunk.entities
				.filter((entity) => entity.type === "bold")
				.map((entity) => chunk.text.slice(entity.offset, entity.offset + entity.length)),
		);
		expect(boldTickerChunks).toContain("AAPL:");
		expect(boldTickerChunks).toContain("TSLA:");
	});

	it("splits a single News section that exceeds the Telegram text budget", () => {
		const news = `AAPL: ${"x".repeat(textBudget + 80)}`;
		const chunks = formatDailyDigestTelegram({
			userAssets: [{ symbol: "AAPL", name: "Apple Inc." }],
			assetPrices: new Map([["AAPL", { price: 228.5, changePercent: 2.5 }]]),
			extras: { news },
			dateLabel: "Fri, Aug 14",
		});
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(textBudget);
			expectTelegramEntitiesInRange(chunk);
		}
		expect(joinDigestText(chunks)).toContain("x".repeat(80));
		expect(
			chunks.some((chunk) => chunk.entities.some((entity) => entity.type === "blockquote")),
		).toBe(true);
		expect(
			chunks.some((chunk) =>
				chunk.entities.some(
					(entity) =>
						entity.type === "bold" &&
						chunk.text.slice(entity.offset, entity.offset + entity.length) === "AAPL:",
				),
			),
		).toBe(true);
	});
});
