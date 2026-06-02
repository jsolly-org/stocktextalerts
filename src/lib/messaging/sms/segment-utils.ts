import { SMS_UCS2_SEGMENT_SIZE } from "../../constants";

interface TextSpan {
	start: number;
	end: number;
}

type SegmentPaddingStyle = "spaces" | "newlines-before-span-start";

const URL_RE = /https?:\/\/\S+/g;

/** Find all URL positions in a message string. */
export function findUrls(message: string): TextSpan[] {
	const spans: TextSpan[] = [];
	URL_RE.lastIndex = 0;
	for (let match = URL_RE.exec(message); match !== null; match = URL_RE.exec(message)) {
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

/** Find each non-empty line as a protected span (start inclusive, end exclusive). */
export function findLineSpans(message: string): TextSpan[] {
	const spans: TextSpan[] = [];
	let lineStart = 0;

	for (let index = 0; index <= message.length; index += 1) {
		if (index < message.length && message[index] !== "\n") {
			continue;
		}

		const lineEnd = index;
		const line = message.slice(lineStart, lineEnd);
		if (line.length > 0) {
			spans.push({ start: lineStart, end: lineEnd });
		}

		lineStart = index + 1;
	}

	return spans;
}

/** Daily Digest lines that should not be split across UCS-2 segments (not section headings). */
function isDailyDigestProtectableLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) {
		return false;
	}
	if (/^Reply STOP to opt out\./.test(trimmed)) {
		return true;
	}
	if (/^Manage your notifications:/.test(trimmed)) {
		return true;
	}
	if (trimmed.includes(" — $")) {
		return true;
	}
	if (/^[A-Z][A-Z0-9.-]{0,9}:/.test(trimmed)) {
		return true;
	}
	return false;
}

function findDailyDigestProtectableLineSpans(message: string): TextSpan[] {
	return findLineSpans(message).filter((span) =>
		isDailyDigestProtectableLine(message.slice(span.start, span.end)),
	);
}

/**
 * When a protectable line immediately follows a section heading, keep the heading
 * with that line so padding does not insert gaps or trailing spaces on the heading.
 */
function expandDailyDigestSpansWithSectionHeadings(message: string, spans: TextSpan[]): TextSpan[] {
	const lines = findLineSpans(message);

	return spans.map((span) => {
		const lineIndex = lines.findIndex((line) => line.start === span.start && line.end === span.end);
		if (lineIndex <= 0) {
			return span;
		}

		const previousLine = lines[lineIndex - 1];
		if (!previousLine) {
			return span;
		}

		const gap = message.slice(previousLine.end, span.start);
		if (gap !== "\n") {
			return span;
		}

		const previousText = message.slice(previousLine.start, previousLine.end);
		if (isDailyDigestProtectableLine(previousText)) {
			return span;
		}

		const expanded = { start: previousLine.start, end: span.end };
		if (expanded.end - expanded.start > SMS_UCS2_SEGMENT_SIZE) {
			return span;
		}

		return expanded;
	});
}

/**
 * Merge spans so a URL fully contained in a line span does not get padded twice.
 * Keeps the outer span when one span fully contains another.
 */
function dedupeNestedSpans(spans: TextSpan[]): TextSpan[] {
	const sorted = [...spans].sort((left, right) => {
		if (left.start !== right.start) {
			return left.start - right.start;
		}

		return right.end - left.end;
	});

	const deduped: TextSpan[] = [];
	for (const span of sorted) {
		const contained = deduped.some(
			(existing) => existing.start <= span.start && existing.end >= span.end,
		);
		if (!contained) {
			deduped.push(span);
		}
	}

	return deduped;
}

/** Protected spans for Daily Digest SMS: URLs plus asset/event/footer lines. */
export function findDailyDigestProtectedSpans(message: string): TextSpan[] {
	const lineSpans = findDailyDigestProtectableLineSpans(message);
	const expanded = expandDailyDigestSpansWithSectionHeadings(message, lineSpans);

	return dedupeNestedSpans([...findUrls(message), ...expanded]);
}

/**
 * Where to insert segment-boundary padding so line-start URLs stay left-aligned.
 * When the URL follows a newline, pad the end of the previous line instead.
 */
function getPaddingInsertPosition(message: string, spanStart: number): number {
	if (spanStart === 0) {
		return 0;
	}
	if (message[spanStart - 1] === "\n") {
		let insertAt = spanStart - 1;
		while (insertAt > 0 && message[insertAt - 1] === "\n") {
			insertAt--;
		}
		return insertAt;
	}
	return spanStart;
}

/** Check if a span straddles a UCS-2 segment boundary. */
export function spanStraddlesBoundary(start: number, end: number): boolean {
	const segStart = Math.floor(start / SMS_UCS2_SEGMENT_SIZE);
	const segEnd = Math.floor((end - 1) / SMS_UCS2_SEGMENT_SIZE);
	return segStart !== segEnd;
}

/** @deprecated Use spanStraddlesBoundary — kept for existing tests and imports. */
export function urlStraddlesBoundary(start: number, end: number): boolean {
	return spanStraddlesBoundary(start, end);
}

/**
 * Insert padding before spans that would straddle a UCS-2 segment boundary,
 * pushing them to the start of the next segment.
 * Skips spans longer than one segment (can't fix those).
 */
export function padSpansToSegmentBoundaries(
	message: string,
	spans: TextSpan[],
	style: SegmentPaddingStyle = "spaces",
): string {
	if (spans.length === 0) {
		return message;
	}

	const sorted = [...spans].sort((left, right) => left.start - right.start);
	let result = message;
	let offset = 0;

	for (const span of sorted) {
		const adjustedStart = span.start + offset;
		const adjustedEnd = span.end + offset;
		const spanLength = adjustedEnd - adjustedStart;

		if (spanLength > SMS_UCS2_SEGMENT_SIZE) {
			continue;
		}

		if (!spanStraddlesBoundary(adjustedStart, adjustedEnd)) {
			continue;
		}

		const nextSegmentStart =
			(Math.floor(adjustedStart / SMS_UCS2_SEGMENT_SIZE) + 1) * SMS_UCS2_SEGMENT_SIZE;
		const padding = nextSegmentStart - adjustedStart;
		const insertAt =
			style === "newlines-before-span-start"
				? adjustedStart
				: getPaddingInsertPosition(result, adjustedStart);
		const pad = style === "newlines-before-span-start" ? "\n".repeat(padding) : " ".repeat(padding);
		result = result.slice(0, insertAt) + pad + result.slice(insertAt);
		offset += padding;
	}

	return result;
}

/**
 * Insert padding before URLs that would straddle a UCS-2 segment boundary,
 * pushing them to the start of the next segment.
 */
export function padUrlsToSegmentBoundaries(message: string): string {
	return padSpansToSegmentBoundaries(message, findUrls(message), "spaces");
}

/** Pad Daily Digest SMS so URLs and digest lines do not straddle UCS-2 segments. */
export function padDailyDigestSmsSegmentBoundaries(message: string): string {
	return padSpansToSegmentBoundaries(
		message,
		findDailyDigestProtectedSpans(message),
		"newlines-before-span-start",
	);
}
