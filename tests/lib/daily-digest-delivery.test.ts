import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessage,
} from "../../src/lib/daily-digest/delivery";
import type { SmsExtras } from "../../src/lib/messaging/sms/delivery";
import type { SparklineData } from "../../src/lib/messaging/sparkline";
import type { UserAssetRow } from "../../src/lib/messaging/types";
import type { AssetPriceMap } from "../../src/lib/providers/price-fetcher";

describe("Daily digest email prices", () => {
	const user = { id: "user-1", email: "test@example.com" };
	const userAssets: UserAssetRow[] = [
		{ symbol: "AAPL", name: "Apple Inc" },
		{ symbol: "MSFT", name: "Microsoft Corp" },
	];
	const extras: SmsExtras = {
		news: null,
		rumors: null,
		analyst: null,
		insider: null,
	};

	const sparklineData: SparklineData = {
		values: [1, 2, 3, 5, 7, 5, 3],
		ascii: "▁▂▃▅▇▅▃",
	};

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "test-secret-key");
		vi.stubEnv("VERCEL_URL", "http://localhost:4321");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("applies change % preferences in daily digest email", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		expect(message.text).not.toContain("💵 Prices");
		expect(message.text).toContain("AAPL — $187.42 (+1.23%)");
		expect(message.text).toContain("MSFT — $412.10 (-0.31%)");
		// Email uses single newline separator
		expect(message.text).toContain(
			"AAPL — $187.42 (+1.23%)\nMSFT — $412.10 (-0.31%)",
		);
		expect(message.html).not.toContain("💵 Prices");
		expect(message.html).toContain("$187.42");
		expect(message.html).toContain("(+1.23%)");
		expect(message.html).toContain("$412.10");
		expect(message.html).toContain("(-0.31%)");
	});

	it("colors positive change green and negative change red in HTML", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		// Green for positive (green-800), red for negative (red-700) — WCAG contrast
		expect(message.html).toContain("color: #166534");
		expect(message.html).toContain("color: #b91c1c");
	});

	it("shows ASCII sparklines in plaintext and SVG in HTML when sparklines provided", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const sparklines = new Map([["AAPL", sparklineData]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			sparklines,
		});

		// Plaintext keeps ASCII sparkline
		expect(message.text).toContain("▁▂▃▅▇▅▃");
		expect(message.text).toContain("+1.23%");
		// HTML gets SVG sparkline <img>
		expect(message.html).toContain("data:image/svg+xml;base64,");
		expect(message.html).toContain("<img ");
	});

	it("SMS uses ASCII sparklines, not SVG", async () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const sparklines = new Map([["AAPL", sparklineData]]);

		const message = await formatDailyDigestSmsMessage({
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			sparklines,
		});

		expect(message).toContain("▁▂▃▅▇▅▃");
		expect(message).not.toContain("data:image/svg+xml;base64,");
	});

	it("always shows change% even with price unavailable", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", null]]);

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			extras,
		});

		expect(message.text).toContain("Your Assets");
		expect(message.text).toContain("AAPL — price unavailable");
		expect(message.text).toContain("MSFT — price unavailable");
	});

	it("formats daily digest SMS with a Your Assets section", async () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);

		const message = await formatDailyDigestSmsMessage({
			userAssets,
			assetPrices,
			extras,
		});

		expect(message).toContain("Your Assets");
		expect(message).not.toContain("Tickers:");
		expect(message).not.toContain("💵 Prices");
		expect(message).toContain("AAPL — $187.42 (+1.23%)");
		expect(message).toContain("MSFT — $412.10 (-0.31%)");
	});

	it("formats rumor ticker sections with blank lines between tickers", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				rumors: "AAPL: First rumor line\nMSFT: Second rumor line",
			},
		});

		expect(message.text).toContain(
			"🤫 Rumors\nAAPL: First rumor line\n\nMSFT: Second rumor line",
		);
		expect(message.html).toContain("<strong>AAPL:</strong> First rumor line");
		expect(message.html).toContain("<strong>MSFT:</strong> Second rumor line");
	});

	it("preserves single blank-line spacing when rumors already contain it", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				rumors: "AAPL: First rumor line\n\nMSFT: Second rumor line",
			},
		});

		expect(message.text).toContain(
			"🤫 Rumors\nAAPL: First rumor line\n\nMSFT: Second rumor line",
		);
		expect(message.text).not.toContain(
			"🤫 Rumors\nAAPL: First rumor line\n\n\nMSFT: Second rumor line",
		);
	});

	it("formats news ticker sections with blank lines between tickers", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras: {
				...extras,
				news: "AAPL: First news line\nMSFT: Second news line",
			},
		});

		expect(message.text).toContain(
			"🗞️ News\nAAPL: First news line\n\nMSFT: Second news line",
		);
		expect(message.html).toContain("<strong>AAPL:</strong> First news line");
		expect(message.html).toContain("<strong>MSFT:</strong> Second news line");
	});

	it("omits price disclaimer when market is open (no closure info)", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
		});

		expect(message.text).not.toContain("Prices reflect");
		expect(message.text).not.toContain("Market Closed");
		expect(message.html).not.toContain("Market Closed");
	});

	it("shows market-closed banner for weekend closure", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message.text).toContain("Market Closed — Weekend");
		expect(message.text).toContain(
			"Prices below reflect the last market close",
		);
		expect(message.text).toMatch(/as of .+EST/);
		expect(message.html).toContain("Market Closed — Weekend");
		expect(message.html).toContain(
			"Prices below reflect the last market close",
		);
		// Banner uses amber styling
		expect(message.html).toContain("#fef3c7");
	});

	it("shows market-closed banner with holiday name", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23, timestamp: 1735837200 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketClosureInfo: { reason: "holiday", holidayName: "Presidents' Day" },
		});

		expect(message.text).toContain("Market Closed — Presidents' Day");
		expect(message.html).toContain("Market Closed — Presidents&#39; Day");
	});

	it("shows market-closed banner without timestamp when no quotes have timestamps", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			extras,
			marketClosureInfo: { reason: "weekend" },
		});

		expect(message.text).toContain("Market Closed — Weekend");
		expect(message.text).toContain(
			"Prices below reflect the last market close.",
		);
		expect(message.text).not.toContain("as of");
	});
});
