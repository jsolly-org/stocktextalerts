import { SMS_UCS2_SEGMENT_SIZE } from "./constants";

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

/** Keep the manage-footer label with its dashboard URL when they fit in one segment. */
function findManageFooterUrlSpans(message: string): TextSpan[] {
	const lines = findLineSpans(message);
	const spans: TextSpan[] = [];

	for (let index = 0; index < lines.length - 1; index += 1) {
		const labelLine = lines[index];
		const urlLine = lines[index + 1];
		if (!labelLine || !urlLine) {
			continue;
		}

		const labelText = message.slice(labelLine.start, labelLine.end).trim();
		if (labelText !== "Manage your notifications:") {
			continue;
		}

		const urlText = message.slice(urlLine.start, urlLine.end).trim();
		if (!/^https?:\/\/\S+$/.test(urlText)) {
			continue;
		}

		const span = { start: labelLine.start, end: urlLine.end };
		if (span.end - span.start <= SMS_UCS2_SEGMENT_SIZE) {
			spans.push(span);
		}
	}

	return spans;
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
	const footerSpans = findManageFooterUrlSpans(message);

	return dedupeNestedSpans([...findUrls(message), ...expanded, ...footerSpans]);
}

/**
 * Where to insert segment-boundary padding without creating visible blank gaps.
 * Keep line-start URLs on their own line; pad other line-start spans before the newline.
 */
function getPaddingInsertPosition(message: string, spanStart: number): number {
	if (spanStart === 0) {
		return 0;
	}
	if (message[spanStart - 1] !== "\n") {
		return spanStart;
	}

	// Pad URL lines in place so the previous line (e.g. manage label) stays clean.
	if (message.startsWith("https://", spanStart) || message.startsWith("http://", spanStart)) {
		return spanStart;
	}

	// Section gap is a blank line (\n\n) before this span — pad the prior line's end.
	if (spanStart >= 2 && message[spanStart - 2] === "\n") {
		return spanStart - 2;
	}

	return spanStart - 1;
}

function getNextSegmentBoundary(index: number): number {
	return (Math.floor(index / SMS_UCS2_SEGMENT_SIZE) + 1) * SMS_UCS2_SEGMENT_SIZE;
}

/**
 * Preserve footer spacing unless a segment boundary lands inside the newline gap.
 * In that case, remove only the newline(s) that would make the next bubble start blank.
 */
function removeSegmentLeadingNewlinesBeforeManageFooter(message: string): string {
	let result = message;
	let searchStart = 0;

	while (searchStart < result.length) {
		const footerStart = result.indexOf("Manage your notifications:", searchStart);
		if (footerStart === -1) {
			break;
		}

		let gapStart = footerStart;
		while (gapStart > 0 && result[gapStart - 1] === "\n") {
			gapStart -= 1;
		}

		if (gapStart === footerStart) {
			searchStart = footerStart + 1;
			continue;
		}

		const boundary = gapStart > 0 ? getNextSegmentBoundary(gapStart - 1) : 0;
		if (boundary >= gapStart && boundary < footerStart && result[boundary] === "\n") {
			result = result.slice(0, boundary) + result.slice(footerStart);
			searchStart = boundary + "Manage your notifications:".length;
			continue;
		}

		searchStart = footerStart + 1;
	}

	return result;
}

/** Check if a span straddles a UCS-2 segment boundary. */
export function spanStraddlesBoundary(start: number, end: number): boolean {
	if (start >= end) {
		return false;
	}
	const segStart = Math.floor(start / SMS_UCS2_SEGMENT_SIZE);
	const segEnd = Math.floor((end - 1) / SMS_UCS2_SEGMENT_SIZE);
	return segStart !== segEnd;
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
	return padSpansToSegmentBoundaries(message, findDailyDigestProtectedSpans(message), "spaces");
}

const DAILY_DIGEST_SMS_MARKER = "StockTextAlerts — Your daily digest";

/**
 * Final UCS-2 segment padding for the exact SMS body sent to Twilio.
 * Daily digests use digest line rules; all other SMS types pad URLs only.
 * Safe to call more than once (for example after format-time padding).
 * Repeats until no protectable span straddles a segment (prefixes can require >1 pass).
 */
export function finalizeSmsBodyForUcs2Segments(body: string): string {
	const pad = body.includes(DAILY_DIGEST_SMS_MARKER)
		? padDailyDigestSmsSegmentBoundaries
		: padUrlsToSegmentBoundaries;

	let result = body;
	for (let outerAttempt = 0; outerAttempt < 4; outerAttempt += 1) {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const next = pad(result);
			if (next === result) {
				break;
			}
			result = next;
		}

		if (!body.includes(DAILY_DIGEST_SMS_MARKER)) {
			break;
		}

		const adjusted = removeSegmentLeadingNewlinesBeforeManageFooter(result);
		if (adjusted === result) {
			break;
		}
		result = adjusted;
	}

	return result;
}
