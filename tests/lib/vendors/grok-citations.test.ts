import { describe, expect, it } from "vitest";
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

	it("emits single-bracket named markdown for channel renderers", () => {
		const result = applyAnnotationsInline(
			"Guidance projecting over 60% revenue growth.[[1]](https://www.cnbc.com/2026/02/01/pltr.html)",
			[],
		);

		expect(result).toMatch(/\[CNBC\]\(https:\/\/www\.cnbc\.com/);
		expect(result).not.toMatch(/\[\[CNBC\]\]/);
	});

	it("normalizes named double-bracket citations via Phase 6 (no URL reparse)", () => {
		const result = applyAnnotationsInline(
			"Growth.[[Yahoo Finance]](https://finance.yahoo.com/news/x) and wiki [[Wiki]](https://en.wikipedia.org/wiki/JavaScript_(programming_language))",
			[],
		);

		expect(result).toContain("[Yahoo Finance](https://finance.yahoo.com/news/x)");
		expect(result).toContain(
			"[Wiki](https://en.wikipedia.org/wiki/JavaScript_(programming_language))",
		);
		expect(result).not.toMatch(/\[\[[^\]]+\]\]\(https?:\/\//);
	});
});
