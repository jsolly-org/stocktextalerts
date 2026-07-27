import { describe, expect, it } from "vitest";
import {
	hasUnrenderedMarkdownLink,
	markdownLinksToPlainText,
	markdownLinksToTelegram,
} from "../../../../src/lib/messaging/parts/markdown-links";

describe("hasUnrenderedMarkdownLink", () => {
	it("detects single- and double-bracket markdown links", () => {
		expect(hasUnrenderedMarkdownLink("[CNBC](https://www.cnbc.com/a)")).toBe(true);
		expect(
			hasUnrenderedMarkdownLink("growth.[[Yahoo Finance]](https://finance.yahoo.com/news/x)"),
		).toBe(true);
		expect(hasUnrenderedMarkdownLink("No links here.")).toBe(false);
		expect(hasUnrenderedMarkdownLink("Yahoo Finance")).toBe(false);
	});
});

describe("markdownLinksToTelegram", () => {
	it("converts the PLTR double-bracket citation into a text_link entity (no raw markdown)", () => {
		const why =
			"PLTR shares rose 5.1% in after-hours trading after the company reported Q4 2025 results that beat estimates on revenue ($1.41B vs. $1.34B expected) and adjusted EPS ($0.25 vs. $0.23), alongside strong 2026 guidance projecting over 60% revenue growth.[[Yahoo Finance]](https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html)";

		const formatted = markdownLinksToTelegram(why);

		expect(hasUnrenderedMarkdownLink(formatted.text)).toBe(false);
		expect(formatted.text).toContain("Yahoo Finance");
		expect(formatted.text).not.toContain("[[Yahoo Finance]]");
		expect(formatted.text).not.toContain("](https://");
		expect(formatted.entities.some((e) => e.type === "text_link")).toBe(true);
		const link = formatted.entities.find((e) => e.type === "text_link");
		expect(link && "url" in link ? link.url : null).toBe(
			"https://finance.yahoo.com/news/why-shares-palantir-soaring-hours-231057869.html",
		);
	});

	it("converts single-bracket citations the same way", () => {
		const formatted = markdownLinksToTelegram(
			"Apple rose after a stronger report [CNBC](https://www.cnbc.com/example).",
		);
		expect(hasUnrenderedMarkdownLink(formatted.text)).toBe(false);
		expect(formatted.text).toBe("Apple rose after a stronger report CNBC.");
		expect(formatted.entities.some((e) => e.type === "text_link")).toBe(true);
	});
});

describe("markdownLinksToPlainText", () => {
	it("never leaves markdown link syntax in plaintext copy", () => {
		const plain = markdownLinksToPlainText(
			"Guidance raised.[[Yahoo Finance]](https://finance.yahoo.com/news/x)",
		);
		expect(hasUnrenderedMarkdownLink(plain)).toBe(false);
		expect(plain).toBe("Guidance raised.Yahoo Finance (https://finance.yahoo.com/news/x)");
	});
});
