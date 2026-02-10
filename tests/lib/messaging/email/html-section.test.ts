import { describe, expect, it } from "vitest";
import {
	formatCitationsText,
	markdownLinksToHtml,
	renderCitationsSection,
	sanitizeCitations,
} from "../../../../src/lib/messaging/email/html-section";

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

describe("sanitizeCitations deduplicates, filters, and caps citation URLs.", () => {
	it("Keeps only http(s) URLs and deduplicates.", () => {
		const urls = [
			"https://example.com/article1",
			"ftp://bad.example",
			"https://example.com/article1",
			"https://example.com/article2",
			"",
			"   ",
		];

		const result = sanitizeCitations(urls);

		expect(result).toEqual([
			"https://example.com/article1",
			"https://example.com/article2",
		]);
	});

	it("Caps at 10 citations.", () => {
		const urls = Array.from(
			{ length: 15 },
			(_, i) => `https://example.com/${i}`,
		);

		const result = sanitizeCitations(urls);

		expect(result.length).toBe(10);
	});

	it("Returns empty array for no valid URLs.", () => {
		expect(sanitizeCitations(["ftp://x", ""])).toEqual([]);
	});
});

describe("renderCitationsSection renders HTML for citation URLs.", () => {
	it("Renders a Sources heading and list of links.", () => {
		const html = renderCitationsSection([
			"https://reuters.com/article",
			"https://wsj.com/story",
		]);

		expect(html).toContain("Sources");
		expect(html).toContain('href="https://reuters.com/article"');
		expect(html).toContain('href="https://wsj.com/story"');
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
	});

	it("Returns empty string when no valid citations.", () => {
		expect(renderCitationsSection([])).toBe("");
		expect(renderCitationsSection(["ftp://invalid"])).toBe("");
	});
});

describe("formatCitationsText renders plain text for citation URLs.", () => {
	it("Formats citations as a bulleted list.", () => {
		const text = formatCitationsText([
			"https://reuters.com/article",
			"https://wsj.com/story",
		]);

		expect(text).toContain("Sources");
		expect(text).toContain("- https://reuters.com/article");
		expect(text).toContain("- https://wsj.com/story");
	});

	it("Returns empty string when no valid citations.", () => {
		expect(formatCitationsText([])).toBe("");
	});
});
