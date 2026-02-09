import { escapeHtml } from "../asset-formatting";

/** Finnhub cloud logo as a base64 data-URI, sized to match inline heading text. */
const FINNHUB_LOGO_IMG = `<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMTEwIj4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZmgiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzZCRDY3NyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMyRUEwNDMiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDwhLS0gQ2xvdWQgLS0+CiAgPHBhdGggZD0iCiAgICBNNTAgODgKICAgIFEzNiA4OCwgMzYgNzQKICAgIFEzNiA2NiwgNDIgNjIKICAgIFEzNiA1MiwgNDQgNDQKICAgIFE1MiAzNiwgNjQgMzgKICAgIFE2NiAyMiwgODIgMTgKICAgIFE5NiAxNCwgMTA0IDI4CiAgICBRMTEwIDIyLCAxMjAgMjYKICAgIFExMzQgMzAsIDEzNCA0NgogICAgUTE0NiA1MCwgMTQ2IDYyCiAgICBRMTQ2IDc2LCAxMzIgODAKICAgIFExMzAgODgsIDExOCA4OAogICAgWgogICIgZmlsbD0idXJsKCNmaCkiLz4KICA8IS0tIFNwZWVkIGxpbmVzIC0tPgogIDxyZWN0IHg9IjQiIHk9IjU0IiB3aWR0aD0iMzAiIGhlaWdodD0iOCIgcng9IjQiIGZpbGw9InVybCgjZmgpIi8+CiAgPHJlY3QgeD0iMTIiIHk9IjY4IiB3aWR0aD0iMjQiIGhlaWdodD0iOCIgcng9IjQiIGZpbGw9InVybCgjZmgpIi8+CiAgPHJlY3QgeD0iMTgiIHk9IjgyIiB3aWR0aD0iMTgiIGhlaWdodD0iOCIgcng9IjQiIGZpbGw9InVybCgjZmgpIi8+Cjwvc3ZnPgo=" alt="Powered by Finnhub" style="height: 16px; width: auto; vertical-align: middle; margin-left: 4px;" />`;

/** Grok (xAI) logo as a base64 data-URI, sized to match inline heading text. */
const GROK_LOGO_IMG = `<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NzggMTYzLjUzIiBzaGFwZS1yZW5kZXJpbmc9Imdlb21ldHJpY1ByZWNpc2lvbiI+PHJlY3Qgd2lkdGg9IjE2My41MyIgaGVpZ2h0PSIxNjMuNTMiIHN0eWxlPSJmaWxsOiMwYTBhMGEiLz48cG9seWdvbiBwb2ludHM9IjEwNS4wMiAzNC41MSAzOC43MiAxMjkuMTkgNTguNjggMTI5LjE5IDEyNC45OCAzNC41MSAxMDUuMDIgMzQuNTEiIHN0eWxlPSJmaWxsOiNmZmYiLz48cGF0aCBkPSJNNDIzLDQyOS4zMWE1Ni43Nyw1Ni43NywwLDAsMS0xNi44MSwyLjgzcS0xNC41NiwwLTI1LjYzLTZhNDIuNDksNDIuNDksMCwwLDEtMTcuMDctMTYuNDIsNDYuMjIsNDYuMjIsMCwwLDEtNi0yMy40NHEwLTE1LjIsNi40NC0yNi4zNGE0NCw0NCwwLDAsMSwxNy4zOS0xNy4wNyw0OS41Myw0OS41MywwLDAsMSwyNC01LjkyLDU3LDU3LDAsMCwxLDE0LjgxLDEuODcsNTQuNjUsNTQuNjUsMCwwLDEsMTIuNDksNWwtNC4xMiwxMS40NmE0Ny4wOCw0Ny4wOCwwLDAsMC0xMC4zNy00LjA2LDQyLjQ2LDQyLjQ2LDAsMCwwLTExLjI3LTEuNzQsNDAuNDQsNDAuNDQsMCwwLDAtMTkuMTMsNC4zOCwzMC43MywzMC43MywwLDAsMC0xMi44MiwxMi40OSwzOC4zNCwzOC4zNCwwLDAsMC00LjUxLDE4Ljk0LDM1LjMsMzUuMywwLDAsMCw0LjUxLDE3LjksMzAuODMsMzAuODMsMCwwLDAsMTIuNzUsMTIuMTcsMzkuOTMsMzkuOTMsMCwwLDAsMTguODEsNC4zMiw0Ni42MSw0Ni42MSwwLDAsMCw5LjUzLTEsMjUuNzQsMjUuNzQsMCwwLDAsNy43My0yLjc3VjM5Ny40OUg0MDUuMTh2LTEyaDMxLjE3djM3LjYxcS00LjI1LDMuMzUtMTMuMzMsNi4xOFoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xNDUgLTMwMi4yMykiIHN0eWxlPSJmaWxsOiMwYTBhMGEiLz48cGF0aCBkPSJNNDc0LjY4LDM4Mi42OGEyOS43NiwyOS43NiwwLDAsMSw4LjA1LTUuMTUsMjEuODUsMjEuODUsMCwwLDEsNy40Ny0xLjkzbC0uNTIsMTJhMTkuNjEsMTkuNjEsMCwwLDAtMTAuNSwyLjMyLDE4LjY3LDE4LjY3LDAsMCwwLTcuMzQsNy4xNSwxOS4xNCwxOS4xNCwwLDAsMC0yLjY0LDkuNzN2MjQuMzVoLTEyVjM3Ny43OWgxMC42OWwuOSwxMi42MmEyMy42NCwyMy42NCwwLDAsMSw1Ljg2LTcuNzNaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTQ1IC0zMDIuMjMpIiBzdHlsZT0iZmlsbDojMGEwYTBhIi8+PHBhdGggZD0iTTUwMi41LDM4OS41N2EyNy4yMywyNy4yMywwLDAsMSwxMC41Ni0xMC4yNCwzMSwzMSwwLDAsMSwxNS4yNi0zLjc0LDMwLjMyLDMwLjMyLDAsMCwxLDE1LjEzLDMuNzQsMjYuNjgsMjYuNjgsMCwwLDEsMTAuMywxMC4xOCwyOC42MiwyOC42MiwwLDAsMSwzLjY3LDE0LjQzLDI5LDI5LDAsMCwxLTMuNjcsMTQuNDksMjYuNDMsMjYuNDMsMCwwLDEtMTAuMzcsMTAuMjQsMzMuNTcsMzMuNTcsMCwwLDEtMzAuNC4xOSwyNi4xLDI2LjEsMCwwLDEtMTAuNS0xMCwyOC44NSwyOC44NSwwLDAsMS0zLjgtMTQuOTQsMjcuOTQsMjcuOTQsMCwwLDEsMy44LTE0LjM2Wm0xMC41NiwyMy43NmExNy4yLDE3LjIsMCwwLDAsNi4xOCw2LjcsMTYuOTQsMTYuOTQsMCwwLDAsMjEuMDYtMi44MywxOC41OSwxOC41OSwwLDAsMCw0Ljg5LTEzLjE0LDE4LjgzLDE4LjgzLDAsMCwwLTQuODktMTMuMiwxNi4wNiwxNi4wNiwwLDAsMC0xMi4zNy01LjM1LDE1LjcxLDE1LjcxLDAsMCwwLTguNzYsMi41MSwxNy45LDE3LjksMCwwLDAtNi4xMiw2Ljc2LDIwLjIxLDIwLjIxLDAsMCwwLDAsMTguNTVaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTQ1IC0zMDIuMjMpIiBzdHlsZT0iZmlsbDojMGEwYTBhIi8+PHBvbHlnb24gcG9pbnRzPSI0NTUuNzIgOTYuNTUgNDc1LjQyIDgwLjcgNDY4LjA4IDc0LjI3IDQ0MC41MiA5Ni40MiA0NDAuNTIgMzQuNzIgNDI4LjU0IDM0LjcyIDQyOC41NCAxMjguODggNDQwLjUyIDEyOC44OCA0NDAuNTIgMTA4LjkxIDQ0Ny40NyAxMDMuMjUgNDYzLjk2IDEyOC44OCA0NzggMTI4Ljg4IDQ1NS43MiA5Ni41NSIgc3R5bGU9ImZpbGw6IzBhMGEwYSIvPjwvc3ZnPgo=" alt="Powered by Grok" style="height: 16px; width: auto; vertical-align: middle; margin-left: 4px;" />`;

const LINK_STYLE = "color: #667eea; text-decoration: underline;";

/**
 * Convert markdown-style links `[text](url)` to clickable HTML `<a>` tags.
 *
 * Non-link text is escaped with `escapeHtml()` to prevent XSS while preserving
 * link markup. Only `http://` and `https://` URLs are linked; anything else is
 * rendered as plain escaped text.
 */
export function markdownLinksToHtml(content: string): string {
	const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	const parts: string[] = [];
	let lastIndex = 0;

	for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
		// Escape the text before this link
		const matchIndex = match.index ?? lastIndex;
		if (matchIndex > lastIndex) {
			parts.push(escapeHtml(content.slice(lastIndex, matchIndex)));
		}
		const linkText = escapeHtml(match[1]);
		const url = escapeHtml(match[2]);
		parts.push(
			`<a href="${url}" style="${LINK_STYLE}" target="_blank" rel="noopener noreferrer">${linkText}</a>`,
		);
		lastIndex = matchIndex + match[0].length;
	}

	// Escape any remaining text after the last link
	if (lastIndex < content.length) {
		parts.push(escapeHtml(content.slice(lastIndex)));
	}

	return parts.join("");
}

/**
 * Render a styled email content section (`<h3>` heading + `<pre>` block).
 *
 * Returns an empty string when `content` is blank so callers can embed the
 * result directly in a template literal without additional checks.
 *
 * When `showFinnhubLogo` or `showGrokLogo` is true, the corresponding logo is
 * appended to the heading to match the attribution badges shown in the dashboard UI.
 */
export function renderEmailSection(
	emoji: string,
	title: string,
	content: string,
	options?: { showFinnhubLogo?: boolean; showGrokLogo?: boolean },
): string {
	if (!content) return "";
	const logos = [
		options?.showGrokLogo ? GROK_LOGO_IMG : "",
		options?.showFinnhubLogo ? FINNHUB_LOGO_IMG : "",
	]
		.filter(Boolean)
		.join("");
	return `<h3 style="margin: 16px 0 6px; font-size: 14px;">${escapeHtml(emoji)} ${escapeHtml(title)}${logos}</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${markdownLinksToHtml(content)}</pre>`;
}
