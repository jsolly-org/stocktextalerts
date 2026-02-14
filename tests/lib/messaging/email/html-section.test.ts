import { describe, expect, it } from "vitest";
import { markdownLinksToHtml } from "../../../../src/lib/messaging/email/html-section";

/* ============= markdownLinksToHtml ============= */
describe("markdownLinksToHtml", () => {
	it("captures URLs containing balanced parentheses (e.g. Wikipedia links).", () => {
		const input =
			"Before <tag> [Wiki](https://en.wikipedia.org/wiki/JavaScript_(programming_language)) after";

		const html = markdownLinksToHtml(input);

		// Non-link text is escaped
		expect(html).toContain("Before &lt;tag&gt; ");
		expect(html).toContain(" after");

		// URL is captured intact (including parentheses) and rendered as a styled link
		expect(html).toContain(
			'<a href="https://en.wikipedia.org/wiki/JavaScript_(programming_language)" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">Wiki</a>',
		);
	});

	it("converts citation-style links with nested brackets like [[1]](url)", () => {
		const input =
			"Chatter on upgrades.[[1]](https://x.com/i/status/123)[[2]](https://x.com/i/status/456)";

		const html = markdownLinksToHtml(input);

		expect(html).toContain(
			'<a href="https://x.com/i/status/123" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">[1]</a>',
		);
		// Adjacent links get a space separator so underlines don't merge
		expect(html).toContain("</a> <a");
		expect(html).toContain(
			'<a href="https://x.com/i/status/456" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">[2]</a>',
		);
	});

	it("converts sequential numbered links from resolved [post:N] markers", () => {
		// After applyAnnotationsInline resolves [post:N] → [[N]](url)
		const input =
			"Chatter on bonds.[[1]](https://x.com/i/status/111)[[2]](https://x.com/i/status/222)";

		const html = markdownLinksToHtml(input);

		expect(html).toContain(
			'<a href="https://x.com/i/status/111" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">[1]</a>',
		);
		expect(html).toContain(
			'<a href="https://x.com/i/status/222" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">[2]</a>',
		);
		// No raw markdown remains
		expect(html).not.toContain("[post:");
	});

	it("converts markdown bold **text** to <strong> tags", () => {
		const input = "**AAPL**: Apple shares fell 3% after news broke.";

		const html = markdownLinksToHtml(input);

		expect(html).toContain("<strong>AAPL</strong>: Apple shares fell 3%");
		// Raw asterisks should not remain
		expect(html).not.toContain("**AAPL**");
	});

	it("handles bold text alongside markdown links", () => {
		const input =
			"**NVDA**: Nvidia rose 5% [CNBC](https://www.cnbc.com/article)";

		const html = markdownLinksToHtml(input);

		expect(html).toContain("<strong>NVDA</strong>");
		expect(html).toContain(
			'<a href="https://www.cnbc.com/article" style="color: #667eea; text-decoration: underline;" target="_blank" rel="noopener noreferrer">CNBC</a>',
		);
	});
});
