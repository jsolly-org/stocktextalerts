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
		show_change_percent: true,
		show_company_name: true,
		detailed_format: true,
	};

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "test-secret");
		vi.stubEnv("VERCEL_URL", "http://localhost:4321");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("applies change %, company name, and detailed format preferences in daily digest email", () => {
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

		expect(message.text).toContain("💵 Prices");
		expect(message.text).toContain("AAPL - Apple Inc — $187.42 (+1.23%)");
		expect(message.text).toContain("MSFT - Microsoft Corp — $412.10 (-0.31%)");
		expect(message.text).toContain(
			"AAPL - Apple Inc — $187.42 (+1.23%)\n\nMSFT - Microsoft Corp — $412.10 (-0.31%)",
		);
		expect(message.html).toContain("💵");
		expect(message.html).toContain("Prices");
		expect(message.html).toContain("$187.42 (+1.23%)");
		expect(message.html).toContain("$412.10 (-0.31%)");
	});

	it("hides change percent when show_change_percent is disabled", () => {
		const assetPrices: AssetPriceMap = new Map([["AAPL", null]]);
		const prefs: FormatPreferences = {
			show_change_percent: false,
			show_company_name: false,
			detailed_format: false,
		};

		const message = formatDailyDigestEmail({
			user,
			userAssets,
			assetPrices,
			formatPrefs: prefs,
			extras,
		});

		expect(message.text).toContain("AAPL — price unavailable");
		expect(message.text).toContain("MSFT — price unavailable");
		expect(message.text).not.toContain("%");
	});

	it("applies preferences to daily digest SMS price lines", () => {
		const assetPrices: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);
		const prefs: FormatPreferences = {
			show_change_percent: false,
			show_company_name: false,
			detailed_format: false,
		};

		const message = formatDailyDigestSmsMessage({
			userAssets,
			assetPrices,
			formatPrefs: prefs,
			extras,
		});

		expect(message).toContain("💵 Prices");
		expect(message).toContain("AAPL — $187.42");
		expect(message).toContain("MSFT — $412.10");
		expect(message).not.toContain("%");
	});
});
