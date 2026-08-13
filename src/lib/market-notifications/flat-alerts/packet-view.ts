import { DateTime } from "luxon";
import { escapeHtml, getSafeHrefUrl } from "../../messaging/parts/html-utils";
import { MARKDOWN_LINK_RE, unwrapCitationLinkText } from "../../messaging/parts/markdown-links";

type PriceMoveReportClaimView = {
	text: string;
	sourceUrl: string | null;
	sourceHost: string | null;
	publishTime: string | null;
};

export type PriceMoveReportView = {
	lede: string;
	ledeHtml: string;
	moveOnset: string | null;
	keyEntity: string | null;
	claims: PriceMoveReportClaimView[];
};

function hostnameOf(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./u, "");
	} catch {
		return null;
	}
}

/** Convert markdown citation links in a lede into escaped HTML anchors. */
export function renderLedeHtml(lede: string): string {
	const parts: string[] = [];
	let lastIndex = 0;
	for (const match of lede.matchAll(MARKDOWN_LINK_RE)) {
		const matchIndex = match.index ?? lastIndex;
		if (matchIndex > lastIndex) {
			parts.push(escapeHtml(lede.slice(lastIndex, matchIndex)));
		}
		const [, captureText, captureUrl] = match;
		if (!captureText || !captureUrl) continue;
		const safeUrl = getSafeHrefUrl(captureUrl);
		const label = escapeHtml(unwrapCitationLinkText(captureText));
		if (safeUrl) {
			const href = escapeHtml(safeUrl);
			parts.push(
				`<a href="${href}" class="link-primary" target="_blank" rel="noopener noreferrer">${label}</a>`,
			);
		} else {
			parts.push(label);
		}
		lastIndex = matchIndex + match[0].length;
	}
	if (lastIndex < lede.length) {
		parts.push(escapeHtml(lede.slice(lastIndex)));
	}
	return parts.join("");
}

function parseClaim(raw: unknown): PriceMoveReportClaimView | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.text !== "string") return null;
	const text = rec.text.trim();
	if (text === "") return null;
	const sourceUrl = typeof rec.source_url === "string" ? getSafeHrefUrl(rec.source_url) : null;
	const publishRaw = typeof rec.publish_time === "string" ? rec.publish_time.trim() : "";
	return {
		text,
		sourceUrl,
		sourceHost: sourceUrl ? hostnameOf(sourceUrl) : null,
		publishTime: publishRaw === "" ? null : publishRaw,
	};
}

/**
 * Shape a stored `last_why_packet` JSON blob for the auth-gated report page.
 * Drops `grade` (internal-only) and refuses non-http(s) claim URLs.
 */
export function parsePriceMoveReportView(raw: unknown): PriceMoveReportView | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.lede !== "string") return null;
	const lede = rec.lede.trim();
	if (lede === "") return null;

	const claims: PriceMoveReportClaimView[] = [];
	if (Array.isArray(rec.claims)) {
		for (const item of rec.claims) {
			const claim = parseClaim(item);
			if (claim) claims.push(claim);
		}
	}

	const moveOnset =
		typeof rec.move_onset === "string" && rec.move_onset.trim() !== ""
			? rec.move_onset.trim()
			: null;
	const keyEntity =
		typeof rec.key_entity === "string" && rec.key_entity.trim() !== ""
			? rec.key_entity.trim()
			: null;

	return {
		lede,
		ledeHtml: renderLedeHtml(lede),
		moveOnset,
		keyEntity,
		claims,
	};
}

export function formatReportAsOf(
	isoTimestamp: string,
	timezone: string,
	use24HourTime: boolean,
): string {
	const dt = DateTime.fromISO(isoTimestamp, { zone: "utc" }).setZone(timezone);
	if (!dt.isValid) return "";
	return dt.toLocaleString({
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: !use24HourTime,
		timeZoneName: "short",
	});
}

/** Format a claim publish_time when it is ISO; otherwise return the raw string. */
export function formatClaimPublishTime(
	raw: string,
	timezone: string,
	use24HourTime: boolean,
): string {
	const formatted = formatReportAsOf(raw, timezone, use24HourTime);
	return formatted === "" ? raw : formatted;
}
