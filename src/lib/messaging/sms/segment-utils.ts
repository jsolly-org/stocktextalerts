import { SMS_UCS2_SEGMENT_SIZE } from "../../constants";

interface UrlSpan {
	start: number;
	end: number;
}

const URL_RE = /https?:\/\/\S+/g;

/** Find all URL positions in a message string. */
export function findUrls(message: string): UrlSpan[] {
	const spans: UrlSpan[] = [];
	URL_RE.lastIndex = 0;
	for (
		let match = URL_RE.exec(message);
		match !== null;
		match = URL_RE.exec(message)
	) {
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

/** Check if a URL straddles a UCS-2 segment boundary. */
export function urlStraddlesBoundary(start: number, end: number): boolean {
	const segStart = Math.floor(start / SMS_UCS2_SEGMENT_SIZE);
	const segEnd = Math.floor((end - 1) / SMS_UCS2_SEGMENT_SIZE);
	return segStart !== segEnd;
}

/**
 * Insert newlines before URLs that would straddle a UCS-2 segment boundary,
 * pushing them to the start of the next segment.
 * Skips URLs longer than one segment (can't fix those).
 */
export function padUrlsToSegmentBoundaries(message: string): string {
	const urls = findUrls(message);
	if (urls.length === 0) return message;

	let result = message;
	let offset = 0;

	for (const url of urls) {
		const adjustedStart = url.start + offset;
		const adjustedEnd = url.end + offset;
		const urlLength = adjustedEnd - adjustedStart;

		// Skip URLs longer than a single segment — can't fix those
		if (urlLength > SMS_UCS2_SEGMENT_SIZE) continue;

		if (urlStraddlesBoundary(adjustedStart, adjustedEnd)) {
			const nextSegmentStart =
				(Math.floor(adjustedStart / SMS_UCS2_SEGMENT_SIZE) + 1) *
				SMS_UCS2_SEGMENT_SIZE;
			const padding = nextSegmentStart - adjustedStart;
			const pad = " ".repeat(padding);
			result =
				result.slice(0, adjustedStart) + pad + result.slice(adjustedStart);
			offset += padding;
		}
	}

	return result;
}
