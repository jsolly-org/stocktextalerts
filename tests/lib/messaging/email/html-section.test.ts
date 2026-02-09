import { describe, expect, it } from "vitest";
import { markdownLinksToHtml } from "../../../../src/lib/messaging/email/html-section";

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
});
