import { describe, expect, it } from "vitest";
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
