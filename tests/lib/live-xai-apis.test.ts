import { describe, expect, it } from "vitest";
import {
	generatePriceAlertSummary,
	type PriceAlertGrokResult,
	type PriceAlertLink,
} from "../../src/lib/market-notifications/grok-summary";
import {
	markdownLinksToHtml,
	stripMarkdownLinks,
} from "../../src/lib/messaging/email/html-section";
import { generateNewsWithGrok, generateRumorsWithGrok } from "../../src/lib/providers/grok";
import { assertLiveProviderKey, isLiveProviderEnabled } from "../helpers/live-api";

/** Bare URL pattern — should not appear in processed summary or rendered output. */
const BARE_URL_RE = /(?<!\(|"|=)https?:\/\/[^\s)<"]+/;

/** Markdown inline link pattern — `[text](url)`. */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

/**
 * Runtime shape validator for `PriceAlertGrokResult`. Returns an array of
 * human-readable reasons the value does not match, or an empty array on success.
 * Used as the first assertion in each live test so a shape regression surfaces
 * with a clear "xAI contract drift" message before any content assertions run.
 */
function validatePriceAlertResultShape(value: unknown): string[] {
	const errors: string[] = [];
	if (value === null || typeof value !== "object") {
		errors.push("result is not an object");
		return errors;
	}
	const obj = value as Record<string, unknown>;

	if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
		errors.push("summary is not a non-empty string");
	} else if (obj.summary.length > 4000) {
		errors.push(`summary too long (${obj.summary.length} chars)`);
	}

	if (!Array.isArray(obj.links)) {
		errors.push("links is not an array");
	} else {
		if (obj.links.length > 3) {
			errors.push(`links has ${obj.links.length} entries (max 3)`);
		}
		for (const [i, link] of obj.links.entries()) {
			if (typeof link !== "object" || link === null) {
				errors.push(`links[${i}] is not an object`);
				continue;
			}
			const l = link as Record<string, unknown>;
			if (typeof l.url !== "string" || !/^https?:\/\//.test(l.url)) {
				errors.push(`links[${i}].url missing or not http(s)`);
			}
			if (typeof l.title !== "string") {
				errors.push(`links[${i}].title is not a string`);
			}
			if (typeof l.source !== "string") {
				errors.push(`links[${i}].source is not a string`);
			}
			if (l.sourceType !== "x" && l.sourceType !== "web") {
				errors.push(`links[${i}].sourceType is not "x" or "web"`);
			}
		}
	}

	return errors;
}

/**
 * Assert that a price-alert result matches the expected shape, with a
 * triage hint in the failure message so live-test failures are self-
 * describing ("xAI contract drift" vs "our parser broken" vs "content bug").
 */
function assertValidPriceAlertShape(
	result: PriceAlertGrokResult | null,
): asserts result is PriceAlertGrokResult {
	const shapeErrors = validatePriceAlertResultShape(result);
	expect(
		shapeErrors,
		shapeErrors.length === 0
			? ""
			: `Price-alert result shape regression (xAI contract drift or parser bug):\n  - ${shapeErrors.join("\n  - ")}`,
	).toEqual([]);
	// Above assertion throws on any shape error, but the explicit narrow
	// helps TypeScript understand `result` is non-null from here on.
	if (result === null) throw new Error("unreachable — shape check already threw");
}

const describeXaiLive = isLiveProviderEnabled("xai") ? describe : describe.skip;

describeXaiLive("xAI live API (opt-in)", () => {
	assertLiveProviderKey({ provider: "xai", envVar: "XAI_API_KEY" });

	it("returns live news content for ticker prompts", {
		timeout: 150_000,
		retry: 2,
	}, async () => {
		const result = await generateNewsWithGrok({
			tickers: ["AAPL"],
			localDateIso: new Date().toISOString().slice(0, 10),
			timezone: "America/New_York",
			requestId: "test-live-xai-news",
		});

		expect(
			result,
			"generateNewsWithGrok returned null — check XAI_API_KEY, rate limit, or content filter",
		).not.toBeNull();
		expect(typeof result?.content).toBe("string");
		expect((result?.content.length ?? 0) > 0, "Grok news content is empty").toBe(true);
		expect(
			result?.content.toUpperCase().includes("AAPL"),
			"Grok news content does not mention the requested ticker (AAPL)",
		).toBe(true);
		expect(Array.isArray(result?.citations)).toBe(true);

		// HTML rendering: inline markdown links become <a> tags, no bare URLs
		const html = markdownLinksToHtml(result?.content ?? "");
		expect(
			html,
			"HTML-rendered Grok news still contains a bare URL — markdownLinksToHtml regression",
		).not.toMatch(BARE_URL_RE);
	});

	it("A user receives a price-alert summary with text and no more than three source links", {
		timeout: 150_000,
		retry: 2,
	}, async () => {
		const result = await generatePriceAlertSummary({
			symbol: "AAPL",
			priceContext: "AAPL is down 5.2% today ($187.50)",
			signalContext: "down 5.20% ($10.30) from previous close, triggered at >=5.0% or >=$10.00",
		});

		// Shape-first: surfaces xAI contract drift or parser regressions
		// before any content-level assertions.
		assertValidPriceAlertShape(result);

		// Content-level assertions (loose — don't depend on specific phrasing)
		expect(
			result.summary.toUpperCase().includes("AAPL"),
			"Price-alert summary does not mention the requested ticker (AAPL)",
		).toBe(true);

		// --- Link-pipeline checks ---
		const { summary, links } = result;
		const html = markdownLinksToHtml(summary);
		const plaintext = stripMarkdownLinks(summary, "keep-text");
		const smsText = stripMarkdownLinks(summary, "remove");

		expect(
			html,
			"HTML-rendered summary still contains a bare URL — markdownLinksToHtml regression",
		).not.toMatch(BARE_URL_RE);
		expect(
			plaintext,
			"Plaintext summary still contains a bare URL — stripMarkdownLinks keep-text regression",
		).not.toMatch(BARE_URL_RE);
		expect(
			smsText,
			"SMS summary still contains a bare URL — stripMarkdownLinks remove regression",
		).not.toMatch(BARE_URL_RE);
		expect(
			smsText,
			"SMS summary contains residual markdown link syntax — stripMarkdownLinks remove regression",
		).not.toMatch(/\[.*\]\(/);

		// Pipeline correctness: every link in result.links must survive into
		// the rendered HTML as an href. This invariant is maintained by
		// parseGrokPriceAlertResponse, which filters links down to URLs still
		// reachable from the (possibly-truncated) summary.
		for (const link of links) {
			expect(
				html,
				`Link ${link.url} is in result.links but missing from rendered HTML — contract drift in parseGrokPriceAlertResponse truncation filter`,
			).toContain(`href="${link.url}"`);
		}

		// Pipeline correctness: every markdown link that is in the summary
		// must also render as an <a> tag. This tests markdownLinksToHtml
		// regardless of whether Grok's specific URLs also appear in `links`.
		const markdownLinksInSummary = [...summary.matchAll(MARKDOWN_LINK_RE)];
		for (const match of markdownLinksInSummary) {
			const url = match[2];
			expect(
				html,
				`Markdown link ${url} in summary did not render as href — markdownLinksToHtml regression`,
			).toContain(`href="${url}"`);
		}

		// Pipeline correctness: if Grok returned any links at all, the
		// rendered HTML should contain at least one <a> tag. Catches a
		// silent regression where markdownLinksToHtml stops emitting anchors.
		if (links.length > 0) {
			expect(
				html,
				"result.links is non-empty but HTML has no <a> tags — markdownLinksToHtml regression",
			).toMatch(/<a\s+href=/);
		}

		// Cross-check: every link object returned is a plausible source
		const validSourceTypes: PriceAlertLink["sourceType"][] = ["x", "web"];
		for (const link of links) {
			expect(validSourceTypes).toContain(link.sourceType);
		}
	});

	it("returns live rumors content for ticker prompts", {
		timeout: 150_000,
		retry: 2,
	}, async () => {
		const result = await generateRumorsWithGrok({
			tickers: ["TSLA"],
			localDateIso: new Date().toISOString().slice(0, 10),
			timezone: "America/New_York",
			requestId: "test-live-xai-rumors",
		});

		expect(
			result,
			"generateRumorsWithGrok returned null — check XAI_API_KEY, rate limit, or content filter",
		).not.toBeNull();
		expect(typeof result?.content).toBe("string");
		expect((result?.content.length ?? 0) > 0, "Grok rumors content is empty").toBe(true);
		expect(
			result?.content.toUpperCase().includes("TSLA"),
			"Grok rumors content does not mention the requested ticker (TSLA)",
		).toBe(true);
		expect(Array.isArray(result?.citations)).toBe(true);

		// HTML rendering: inline markdown links become <a> tags, no bare URLs
		const html = markdownLinksToHtml(result?.content ?? "");
		expect(
			html,
			"HTML-rendered Grok rumors still contains a bare URL — markdownLinksToHtml regression",
		).not.toMatch(BARE_URL_RE);
	});
});
