import { describe, expect, it } from "vitest";
import { generatePriceAlertSummary } from "../../src/lib/market-notifications/grok-summary";
import {
	generateNewsWithGrok,
	generateRumorsWithGrok,
} from "../../src/lib/providers/grok";
import {
	assertLiveProviderKey,
	isLiveProviderEnabled,
} from "../helpers/live-api";

const describeXaiLive = isLiveProviderEnabled("xai") ? describe : describe.skip;

describeXaiLive("xAI live API (opt-in)", () => {
	assertLiveProviderKey({ provider: "xai", envVar: "XAI_API_KEY" });

	it("returns live news content for ticker prompts", {
		timeout: 150_000,
	}, async () => {
		const result = await generateNewsWithGrok({
			tickers: ["AAPL"],
			localDateIso: new Date().toISOString().slice(0, 10),
			timezone: "America/New_York",
			requestId: "test-live-xai-news",
		});

		expect(result).not.toBeNull();
		expect(typeof result?.content).toBe("string");
		expect((result?.content.length ?? 0) > 0).toBe(true);
		expect(result?.content).toMatch(/\bAAPL\s*:/i);
		expect(Array.isArray(result?.citations)).toBe(true);
	});

	it("returns price alert summary with links", {
		timeout: 150_000,
	}, async () => {
		const result = await generatePriceAlertSummary({
			symbol: "AAPL",
			priceContext: "AAPL is down 5.2% today ($187.50)",
			signalContext:
				"down 5.20% ($10.30) from previous close, triggered at >=5.0% or >=$10.00",
		});

		expect(result).not.toBeNull();
		expect(typeof result?.summary).toBe("string");
		expect((result?.summary.length ?? 0) > 0).toBe(true);
		expect(Array.isArray(result?.links)).toBe(true);
		// Links should have the expected shape when present
		for (const link of result?.links ?? []) {
			expect(link.url).toMatch(/^https?:\/\//);
			expect(typeof link.title).toBe("string");
			expect(typeof link.source).toBe("string");
			expect(["x", "web"]).toContain(link.sourceType);
		}
	});

	it("returns live rumors content for ticker prompts", {
		timeout: 150_000,
	}, async () => {
		const result = await generateRumorsWithGrok({
			tickers: ["TSLA"],
			localDateIso: new Date().toISOString().slice(0, 10),
			timezone: "America/New_York",
			requestId: "test-live-xai-rumors",
		});

		expect(result).not.toBeNull();
		expect(typeof result?.content).toBe("string");
		expect((result?.content.length ?? 0) > 0).toBe(true);
		expect(result?.content).toMatch(/\bTSLA\s*:/i);
		expect(Array.isArray(result?.citations)).toBe(true);
	});
});
