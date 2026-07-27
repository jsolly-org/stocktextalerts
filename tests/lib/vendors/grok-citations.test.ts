import { describe, expect, it } from "vitest";
import { hasUnrenderedMarkdownLink } from "../../../src/lib/messaging/parts/markdown-links";
import { applyAnnotationsInline } from "../../../src/lib/vendors/grok-citations";

describe("applyAnnotationsInline citation links", () => {
	it("rewrites Grok numeric [[N]](url) citations to single-bracket named markdown links", () => {
		const text =
			"PLTR shares rose 5.1% in after-hours trading after the company reported Q4 2025 results.[[1]](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)";

		const result = applyAnnotationsInline(text, []);

		expect(result).toContain(
			"[Yahoo Finance](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)",
		);
		expect(result).not.toContain("[[Yahoo Finance]]");
		expect(result).not.toMatch(/\[\[[^\]]+\]\]\(https?:\/\//);
	});

	it("resolves [web:N] markers to single-bracket named links (never double brackets)", () => {
		const result = applyAnnotationsInline("Beat estimates on revenue [web:0]", [
			{
				type: "url_citation",
				url: "https://finance.yahoo.com/news/example.html",
				start_index: null,
				end_index: null,
			},
		]);

		expect(result).toBe(
			"Beat estimates on revenue [Yahoo Finance](https://finance.yahoo.com/news/example.html)",
		);
		expect(result).not.toContain("[[Yahoo Finance]]");
	});

	it("never leaves double-bracket markdown that would show as unrendered copy", () => {
		const result = applyAnnotationsInline(
			"Guidance projecting over 60% revenue growth.[[1]](https://www.cnbc.com/2026/02/01/pltr.html)",
			[],
		);

		// Named citations must be proper `[Label](url)` — Telegram entities and email HTML
		// both treat double-bracket forms as broken / half-rendered copy.
		expect(hasUnrenderedMarkdownLink(result)).toBe(true); // still markdown until channel render
		expect(result).toMatch(/\[CNBC\]\(https:\/\/www\.cnbc\.com/);
		expect(result).not.toMatch(/\[\[CNBC\]\]/);
	});
});
