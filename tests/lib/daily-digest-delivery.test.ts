import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessage,
} from "../../src/lib/daily-digest/delivery";
import type { SmsExtras } from "../../src/lib/messaging/sms/delivery";
import type {
	FormatPreferences,
	UserAssetRow,
} from "../../src/lib/messaging/types";
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
	const defaultPrefs: FormatPreferences = {
		show_sparklines: true,
	};

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "test-secret");
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
			formatPrefs: defaultPrefs,
			extras,
		});

		expect(message.text).not.toContain("💵 Prices");
		expect(message.text).toContain("AAPL — $187.42 (+1.23%)");
		expect(message.text).toContain("MSFT — $412.10 (-0.31%)");
		// Email uses single newline separator (renders inside <pre>)
		expect(message.text).toContain(
			"AAPL — $187.42 (+1.23%)\nMSFT — $412.10 (-0.31%)",
		);
		expect(message.html).not.toContain("💵 Prices");
		expect(message.html).toContain("$187.42 (+1.23%)");
		expect(message.html).toContain("$412.10 (-0.31%)");
	});

	it("hides sparklines when show_sparklines is disabled but still shows change%", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const sparklines = new Map([["AAPL", "▁▂▃▅▇▅▃"]]);
		const prefs: FormatPreferences = {
			show_sparklines: false,
		};

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			formatPrefs: prefs,
			extras,
			sparklines,
		});

		// Change% should always be shown
		expect(message.text).toContain("+1.23%");
		// Sparklines should NOT appear
		expect(message.text).not.toContain("▁▂▃▅▇▅▃");
	});

	it("shows sparklines when enabled with sparkline data", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const sparklines = new Map([["AAPL", "▁▂▃▅▇▅▃"]]);
		const prefs: FormatPreferences = {
			show_sparklines: true,
		};

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			formatPrefs: prefs,
			extras,
			sparklines,
		});

		expect(message.text).toContain("▁▂▃▅▇▅▃");
		expect(message.text).toContain("+1.23%");
	});

	it("always shows change% even with price unavailable", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", null]]);
		const prefs: FormatPreferences = {
			show_sparklines: false,
		};

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			formatPrefs: prefs,
			extras,
		});

		expect(message.text).toContain("Daily digest");
		expect(message.text).toContain("AAPL — price unavailable");
		expect(message.text).toContain("MSFT — price unavailable");
	});

	it("applies preferences to daily digest SMS price lines", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);
		const prefs: FormatPreferences = {
			show_sparklines: false,
		};

		const message = formatDailyDigestSmsMessage({
			userAssets,
			assetPrices,
			formatPrefs: prefs,
			extras,
		});

		expect(message).toContain("💵 Prices");
		expect(message).toContain("AAPL — $187.42 (+1.23%)");
		expect(message).toContain("MSFT — $412.10 (-0.31%)");
	});

	it("adds a blank line between rumor ticker sections", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);

		const message = formatDailyDigestEmail({
			user,
			userAssets: [userAssets[0]],
			assetPrices,
			formatPrefs: defaultPrefs,
			extras: {
				...extras,
				rumors: "AAPL: First rumor line\nMSFT: Second rumor line",
			},
		});

		expect(message.text).toContain(
			"🤫 Rumors\nAAPL: First rumor line\n\nMSFT: Second rumor line",
		);
		expect(message.html).toContain(
			"AAPL: First rumor line\n\nMSFT: Second rumor line",
		);
	});
});
