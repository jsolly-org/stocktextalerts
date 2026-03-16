import { describe, expect, it } from "vitest";
import { generatePriceAlertSummary } from "../../src/lib/market-notifications/grok-summary";
import {
	markdownLinksToHtml,
	stripMarkdownLinks,
} from "../../src/lib/messaging/email/html-section";
import {
	generateNewsWithGrok,
	generateRumorsWithGrok,
} from "../../src/lib/providers/grok";
import {
	assertLiveProviderKey,
	isLiveProviderEnabled,
} from "../helpers/live-api";

/** Bare URL pattern — should not appear in processed summary or rendered output. */
const BARE_URL_RE = /(?<!\(|"|=)https?:\/\/[^\s)<"]+/;

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

		// HTML rendering: inline markdown links become <a> tags, no bare URLs
		const html = markdownLinksToHtml(result?.content ?? "");
		expect(html).not.toMatch(BARE_URL_RE);
	});

	it("A user receives a price-alert summary with text and no more than three source links", {
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
		expect(result?.links.length ?? 0).toBeLessThanOrEqual(3);
		// Links should have the expected shape when present
		for (const link of result?.links ?? []) {
			expect(link.url).toMatch(/^https?:\/\//);
			expect(typeof link.title).toBe("string");
			expect(typeof link.source).toBe("string");
			expect(["x", "web"]).toContain(link.sourceType);
		}

		// --- Link formatting pipeline checks ---
		const summary = result?.summary ?? "";

		// HTML email: inline markdown links become <a> tags, no bare URLs remain
		const html = markdownLinksToHtml(summary);
		expect(html).not.toMatch(BARE_URL_RE);
		// Every link from the links array should appear as an href in the HTML
		for (const link of result?.links ?? []) {
			expect(html).toContain(`href="${link.url}"`);
		}

		// Plaintext email: markdown links stripped to readable text, no raw URLs
		const plaintext = stripMarkdownLinks(summary, "keep-text");
		expect(plaintext).not.toMatch(BARE_URL_RE);

		// SMS: markdown links fully removed, no raw URLs
		const smsText = stripMarkdownLinks(summary, "remove");
		expect(smsText).not.toMatch(BARE_URL_RE);
		expect(smsText).not.toMatch(/\[.*\]\(/); // no residual markdown
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

		// HTML rendering: inline markdown links become <a> tags, no bare URLs
		const html = markdownLinksToHtml(result?.content ?? "");
		expect(html).not.toMatch(BARE_URL_RE);
	});
});
