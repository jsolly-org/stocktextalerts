import { escapeHtml } from "../stock-formatting";

/**
 * Render a styled email content section (`<h3>` heading + `<pre>` block).
 *
 * Returns an empty string when `content` is blank so callers can embed the
 * result directly in a template literal without additional checks.
 */
export function renderEmailSection(
	emoji: string,
	title: string,
	content: string,
): string {
	if (!content) return "";
	return `<h3 style="margin: 16px 0 6px; font-size: 14px;">${emoji} ${title}</h3><pre style="white-space: pre-wrap; margin: 0; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${escapeHtml(content)}</pre>`;
}
