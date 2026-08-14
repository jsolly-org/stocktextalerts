import { FormattedString } from "@grammyjs/parse-mode";

/** Telegram sendMessage text limit (UTF-16 code units; JS string length / entity offsets). */
export const TELEGRAM_TEXT_MAX_UTF16 = 4096;
/** Leave a small margin so entity formatting / edge cases do not exceed the cap. */
export const TELEGRAM_TEXT_MARGIN = 16;

const BLANK_LINE = "\n\n";
const NEWLINE = "\n";

function isNonEmpty(part: FormattedString): boolean {
	return part.text.length > 0;
}

function splitByPlain(part: FormattedString, separator: string): FormattedString[] {
	return FormattedString.splitByText(part, new FormattedString(separator)).filter(isNonEmpty);
}

/** Slice an oversized part into budget-sized windows, preserving entities. */
function sliceByBudget(part: FormattedString, budget: number): FormattedString[] {
	if (budget < 1) return [];
	const chunks: FormattedString[] = [];
	for (let offset = 0; offset < part.text.length; offset += budget) {
		const piece = part.slice(offset, offset + budget);
		if (piece.text.length > 0) chunks.push(piece);
	}
	return chunks;
}

/**
 * Greedy-pack parts that are already ≤ budget. Caller must explode oversized
 * parts first; anything still over is hard-sliced as a backstop.
 */
function packWithSeparator(
	parts: readonly FormattedString[],
	budget: number,
	separator: string,
): FormattedString[] {
	const sepLen = separator.length;
	const chunks: FormattedString[] = [];
	let current: FormattedString | null = null;

	const flush = () => {
		if (current !== null) {
			chunks.push(current);
			current = null;
		}
	};

	for (const part of parts) {
		if (!isNonEmpty(part)) continue;
		if (part.text.length > budget) {
			flush();
			chunks.push(...sliceByBudget(part, budget));
			continue;
		}
		if (current === null) {
			current = part;
			continue;
		}
		if (current.text.length + sepLen + part.text.length <= budget) {
			current = FormattedString.join([current, part], separator);
			continue;
		}
		flush();
		current = part;
	}
	flush();
	return chunks;
}

function explodeLines(part: FormattedString, budget: number): FormattedString[] {
	if (part.text.length <= budget) return [part];
	const lines = splitByPlain(part, NEWLINE);
	if (lines.length > 1) {
		const atoms = lines.flatMap((line) =>
			line.text.length <= budget ? [line] : sliceByBudget(line, budget),
		);
		return packWithSeparator(atoms, budget, NEWLINE);
	}
	return sliceByBudget(part, budget);
}

/** Split one oversized part on blank lines, then newlines, then hard-slice. */
function explodePart(part: FormattedString, budget: number): FormattedString[] {
	if (part.text.length <= budget) return [part];
	const blanks = splitByPlain(part, BLANK_LINE);
	if (blanks.length > 1) {
		const atoms = blanks.flatMap((piece) =>
			piece.text.length <= budget ? [piece] : explodeLines(piece, budget),
		);
		return packWithSeparator(atoms, budget, BLANK_LINE);
	}
	return explodeLines(part, budget);
}

/**
 * Greedy-pack formatted Telegram parts into sendMessage-sized chunks.
 *
 * Adjacent parts that fit together are joined with a blank line. A single part
 * over the budget is split on blank lines, then newlines, then hard-sliced.
 */
export function packFormattedStrings(
	parts: readonly FormattedString[],
	maxUtf16: number = TELEGRAM_TEXT_MAX_UTF16 - TELEGRAM_TEXT_MARGIN,
): FormattedString[] {
	const exploded = parts.filter(isNonEmpty).flatMap((part) => explodePart(part, maxUtf16));
	return packWithSeparator(exploded, maxUtf16, BLANK_LINE);
}
