import type { InsiderTransaction, RecommendationTrend } from "../types";

/**
 * Format a revenue estimate compactly for display.
 */
function formatRevenue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${Math.round(abs / 1_000_000)}M`;
	return abs.toLocaleString("en-US");
}

/**
 * Format a split ratio as a human-readable string (e.g. "10:1" or "1:5 reverse").
 */
function formatSplitRatio(splitFrom: number, splitTo: number, adjustmentType: string): string {
	const isReverse = adjustmentType === "reverse_split" || splitTo < splitFrom;
	if (isReverse) {
		return `${splitFrom}:${splitTo} reverse`;
	}
	return `${splitTo}:${splitFrom}`;
}

/** Map Massive dividend frequency codes to labels. */
const FREQUENCY_LABELS: Record<number, string> = {
	1: "annual",
	2: "semi-annual",
	4: "quarterly",
	12: "monthly",
};

/**
 * Format a countdown label for an event based on `daysUntil`.
 *
 * - 0 → "today"
 * - 1 → "tomorrow"
 * - 2+ → "in N days (MM-DD)"
 */
function formatDateLabel(eventDate: string, daysUntil: number): string {
	if (daysUntil === 0) return "today";
	if (daysUntil === 1) return "tomorrow";
	return `in ${daysUntil} days (${eventDate.slice(5)})`;
}

type AssetEvent = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split" | "ipo";
	event_date: string;
	data: Record<string, unknown>;
	daysUntil: number;
};

type AssetEventsSections = {
	earnings: string | null;
	dividends: string | null;
	splits: string | null;
	ipos: string | null;
};

/**
 * Compact (SMS-style) rendering of asset events grouped by type.
 *
 * Events are grouped by type (earnings, dividends, splits, IPOs).
 * Each event carries a `daysUntil` countdown for the date label:
 * 0 → "today", 1 → "tomorrow", 2+ → "in N days (MM-DD)".
 */
function formatAssetEventsSectionCompact(events: AssetEvent[]): AssetEventsSections {
	const earningsLines: string[] = [];
	const dividendLines: string[] = [];
	const splitLines: string[] = [];
	const ipoLines: string[] = [];

	for (const event of events) {
		const dateLabel = formatDateLabel(event.event_date, event.daysUntil);

		if (event.event_type === "earnings") {
			const time = event.data.time as string | null;
			const timeLabel = time ? ` (${time})` : "";
			earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}`);
		} else if (event.event_type === "dividend") {
			const amount = event.data.cashAmount as number;
			dividendLines.push(`${event.symbol}: ex-div ${dateLabel} $${amount.toFixed(2)}`);
		} else if (event.event_type === "split") {
			const splitFrom = event.data.splitFrom as number;
			const splitTo = event.data.splitTo as number;
			const adjType = event.data.adjustmentType as string;
			const ratio = formatSplitRatio(splitFrom, splitTo, adjType);
			splitLines.push(`${event.symbol}: split ${dateLabel} ${ratio}`);
		} else if (event.event_type === "ipo") {
			ipoLines.push(`${event.symbol}: IPO ${dateLabel}`);
		}
	}

	return {
		earnings: earningsLines.length > 0 ? earningsLines.join("\n") : null,
		dividends: dividendLines.length > 0 ? dividendLines.join("\n") : null,
		splits: splitLines.length > 0 ? splitLines.join("\n") : null,
		ipos: ipoLines.length > 0 ? ipoLines.join("\n") : null,
	};
}

/**
 * Rich (email/Telegram-style) rendering of asset events grouped by type.
 *
 * Includes estimates, pay dates, frequencies, split-type labels, and issuer
 * names that the compact rendering omits.
 */
function formatAssetEventsSectionRich(events: AssetEvent[]): AssetEventsSections {
	const earningsLines: string[] = [];
	const dividendLines: string[] = [];
	const splitLines: string[] = [];
	const ipoLines: string[] = [];

	for (const event of events) {
		const dateLabel = formatDateLabel(event.event_date, event.daysUntil);

		if (event.event_type === "earnings") {
			const time = event.data.time as string | null;
			const timeLabel = time ? ` (${time})` : "";
			const estimates: string[] = [];
			const eps = event.data.epsEstimate as number | null;
			const rev = event.data.revenueEstimate as number | null;
			if (eps !== null && eps !== undefined) estimates.push(`EPS est. $${eps.toFixed(2)}`);
			if (rev !== null && rev !== undefined) estimates.push(`Rev est. $${formatRevenue(rev)}`);
			const estimateStr = estimates.length > 0 ? ` — ${estimates.join(", ")}` : "";
			earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}${estimateStr}`);
		} else if (event.event_type === "dividend") {
			const amount = event.data.cashAmount as number;
			const payDate = event.data.payDate as string | null;
			const payStr = payDate ? ` (pays ${payDate.slice(5)})` : "";
			const freq = event.data.frequency as number | null;
			const freqStr = freq && FREQUENCY_LABELS[freq] ? `, ${FREQUENCY_LABELS[freq]}` : "";
			dividendLines.push(
				`${event.symbol}: ex-div ${dateLabel} — $${amount.toFixed(2)}/share${payStr}${freqStr}`,
			);
		} else if (event.event_type === "split") {
			const splitFrom = event.data.splitFrom as number;
			const splitTo = event.data.splitTo as number;
			const adjType = event.data.adjustmentType as string;
			const isReverse = adjType === "reverse_split" || splitTo < splitFrom;
			const numericRatio = isReverse ? `${splitFrom}:${splitTo}` : `${splitTo}:${splitFrom}`;
			const typeLabel = isReverse ? "reverse split" : "forward split";
			splitLines.push(`${event.symbol}: split ${dateLabel} — ${numericRatio} ${typeLabel}`);
		} else if (event.event_type === "ipo") {
			const issuer = event.data.issuerName as string | undefined;
			const issuerSuffix = issuer ? ` — ${issuer}` : "";
			ipoLines.push(`${event.symbol}: IPO ${dateLabel}${issuerSuffix}`);
		}
	}

	return {
		earnings: earningsLines.length > 0 ? earningsLines.join("\n") : null,
		dividends: dividendLines.length > 0 ? dividendLines.join("\n") : null,
		splits: splitLines.length > 0 ? splitLines.join("\n") : null,
		ipos: ipoLines.length > 0 ? ipoLines.join("\n") : null,
	};
}

/** SMS-formatted asset-events section (compact one-liners). Returns `null`-valued fields when empty. */
export function formatAssetEventsSectionSms(events: AssetEvent[]): AssetEventsSections {
	return formatAssetEventsSectionCompact(events);
}

/** Email-formatted asset-events section (rich, with estimates/pay dates/issuers). */
export function formatAssetEventsSectionEmail(events: AssetEvent[]): AssetEventsSections {
	return formatAssetEventsSectionRich(events);
}

/** Telegram-formatted asset-events section (rich rendering, matching email). */
export function formatAssetEventsSectionTelegram(events: AssetEvent[]): AssetEventsSections {
	return formatAssetEventsSectionRich(events);
}

/** Compact (SMS-style) analyst recommendation trend rendering. */
function formatAnalystSectionCompact(data: Map<string, RecommendationTrend | null>): string | null {
	const lines: string[] = [];
	for (const [symbol, trend] of data) {
		if (!trend) continue;
		lines.push(`${symbol}: ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Rich (email/Telegram-style) analyst recommendation trend rendering. */
function formatAnalystSectionRich(data: Map<string, RecommendationTrend | null>): string | null {
	const lines: string[] = [];
	for (const [symbol, trend] of data) {
		if (!trend) continue;
		lines.push(
			`${symbol}: ${trend.strongBuy} Strong Buy, ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell, ${trend.strongSell} Strong Sell (${trend.period})`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Format analyst recommendation trends as a compact SMS text block. */
export function formatAnalystSectionSms(
	data: Map<string, RecommendationTrend | null>,
): string | null {
	return formatAnalystSectionCompact(data);
}

/** Format analyst recommendation trends as a rich email text block. */
export function formatAnalystSectionEmail(
	data: Map<string, RecommendationTrend | null>,
): string | null {
	return formatAnalystSectionRich(data);
}

/** Format analyst recommendation trends as a rich Telegram text block (matching email). */
export function formatAnalystSectionTelegram(
	data: Map<string, RecommendationTrend | null>,
): string | null {
	return formatAnalystSectionRich(data);
}

/** Format a share count compactly (e.g. 1200 -> "1k"). */
function formatShareCount(shares: number): string {
	const abs = Math.abs(shares);
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}k`;
	return abs.toLocaleString("en-US");
}

/** Render insider transactions as a text block, capping the number shown per ticker. */
function formatInsiderSectionWithCap(
	data: Map<string, InsiderTransaction[]>,
	maxPerTicker: number,
): string | null {
	const lines: string[] = [];

	for (const [symbol, transactions] of data) {
		if (transactions.length === 0) continue;
		const shown = transactions.slice(0, maxPerTicker);
		for (const tx of shown) {
			const action = tx.change > 0 ? "bought" : "sold";
			const shares = formatShareCount(tx.change);
			const date = tx.transactionDate.slice(5); // MM-DD
			lines.push(`${symbol}: ${tx.name} ${action} ${shares} shares (${date})`);
		}
	}
	if (lines.length > 0) return lines.join("\n");
	return null;
}

/** Format insider transactions as a compact SMS text block (top 2 per ticker). */
export function formatInsiderSectionSms(data: Map<string, InsiderTransaction[]>): string | null {
	return formatInsiderSectionWithCap(data, 2);
}

/** Format insider transactions as a rich email text block (up to 5 per ticker). */
export function formatInsiderSectionEmail(data: Map<string, InsiderTransaction[]>): string | null {
	return formatInsiderSectionWithCap(data, 5);
}

/** Format insider transactions as a rich Telegram text block (up to 5 per ticker, matching email). */
export function formatInsiderSectionTelegram(
	data: Map<string, InsiderTransaction[]>,
): string | null {
	return formatInsiderSectionWithCap(data, 5);
}
