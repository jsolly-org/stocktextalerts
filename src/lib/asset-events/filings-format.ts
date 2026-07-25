/**
 * Channel-specific SEC filings formatters that need Telegram FormattedString /
 * safe href helpers (kept separate from the plain format.ts text helpers).
 */
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { getSafeHrefUrl } from "../messaging/parts/html-utils";
import type { SecFilingLine } from "./types";

/** Telegram: each filing line is a single tappable link spanning the label. */
export function formatFilingsSectionTelegram(lines: SecFilingLine[]): FormattedString | null {
	if (lines.length === 0) return null;
	let block: FormattedString | null = null;
	for (const line of lines) {
		const safeUrl = getSafeHrefUrl(line.url);
		const rendered = safeUrl ? FormattedString.link(line.label, safeUrl) : line.label;
		block = block === null ? fmt`${rendered}` : fmt`${block}\n${rendered}`;
	}
	return block;
}
