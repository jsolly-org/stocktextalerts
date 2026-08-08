import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { getSafeHrefUrl } from "./html-utils";

/**
 * Match markdown links `[text](url)` where the URL is http(s) and may contain
 * balanced parentheses (common in Wikipedia URLs like `JavaScript_(programming_language)`).
 *
 * Notes:
 * - The link text allows one level of nested brackets so citation-style links
 *   like `[[1]](url)` / `[[Yahoo Finance]](url)` are matched.
 * - We keep the URL "no whitespace" rule to avoid swallowing following text.
 * - Nested parentheses up to 2 levels — enough for common real-world links.
 */
export const MARKDOWN_LINK_RE =
	/\[((?:[^[\]]+|\[[^\]]*\])+)\]\(((?:https?:\/\/)(?:[^\s()]+|\((?:[^\s()]+|\([^\s()]*\))*\))*)\)/g;

/** True when copy still contains markdown link syntax (`…](https://…`). */
export function hasUnrenderedMarkdownLink(content: string): boolean {
	return /\]\((?:https?:\/\/)/.test(content);
}

/**
 * Unwrap one outer bracket layer when the whole link text is `[…]`
 * (Grok citation-style `[[Label]](url)` → display label `Label`).
 */
export function unwrapCitationLinkText(text: string): string {
	const m = /^\[([^\]]*)\]$/.exec(text);
	return m?.[1] ?? text;
}

/** Convert markdown links into Telegram `text_link` entities (plain text + entities). */
export function markdownLinksToTelegram(content: string): FormattedString {
	let result: FormattedString | null = null;
	let lastIndex = 0;

	for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
		const matchIndex = match.index ?? lastIndex;
		if (matchIndex > lastIndex) {
			const plain = content.slice(lastIndex, matchIndex);
			result = result === null ? fmt`${plain}` : fmt`${result}${plain}`;
		}
		const [, captureText, captureUrl] = match;
		if (captureText && captureUrl) {
			const label = unwrapCitationLinkText(captureText);
			const safeUrl = getSafeHrefUrl(captureUrl);
			const rendered = safeUrl ? FormattedString.link(label, safeUrl) : label;
			result = result === null ? fmt`${rendered}` : fmt`${result}${rendered}`;
		}
		lastIndex = matchIndex + match[0].length;
	}

	if (lastIndex < content.length) {
		const plain = content.slice(lastIndex);
		result = result === null ? fmt`${plain}` : fmt`${result}${plain}`;
	}
	return result ?? fmt``;
}

/** Convert markdown links to `Label (url)` for plaintext channels. */
export function markdownLinksToPlainText(content: string): string {
	return content.replace(MARKDOWN_LINK_RE, (_match, text: string, url: string) => {
		const label = unwrapCitationLinkText(text);
		return `${label} (${url})`;
	});
}
