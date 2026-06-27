import type { InsiderTransaction, RecommendationTrend } from "./types";

type DeliveryChannel = "sms" | "email";

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
 * - undefined → MM-DD (backward compatible)
 */
function formatDateLabel(eventDate: string, daysUntil: number | undefined): string {
	if (daysUntil === undefined) {
		return eventDate.slice(5); // MM-DD
	}
	if (daysUntil === 0) return "today";
	if (daysUntil === 1) return "tomorrow";
	return `in ${daysUntil} days (${eventDate.slice(5)})`;
}

/**
 * Format asset events from the DB into a channel-appropriate text block.
 *
 * Events are grouped by type (earnings, dividends, splits, IPOs).
 * Returns `null` when there are no events.
 *
 * Each event may include an optional `daysUntil` field for countdown display:
 * - 0 → "today", 1 → "tomorrow", 2+ → "in N days (MM-DD)"
 * - When absent, existing MM-DD format is used (backward compatible).
 */
export function formatAssetEventsSection(
	events: Array<{
		symbol: string;
		event_type: "earnings" | "dividend" | "split" | "ipo";
		event_date: string;
		data: Record<string, unknown>;
		daysUntil?: number;
	}>,
	channel: DeliveryChannel,
): {
	earnings: string | null;
	dividends: string | null;
	splits: string | null;
	ipos: string | null;
} {
	const earningsLines: string[] = [];
	const dividendLines: string[] = [];
	const splitLines: string[] = [];
	const ipoLines: string[] = [];

	for (const event of events) {
		const dateLabel = formatDateLabel(event.event_date, event.daysUntil);

		if (event.event_type === "earnings") {
			const time = event.data.time as string | null;
			const timeLabel = time ? ` (${time})` : "";
			if (channel === "sms") {
				earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}`);
			} else {
				const estimates: string[] = [];
				const eps = event.data.epsEstimate as number | null;
				const rev = event.data.revenueEstimate as number | null;
				if (eps !== null && eps !== undefined) estimates.push(`EPS est. $${eps.toFixed(2)}`);
				if (rev !== null && rev !== undefined) estimates.push(`Rev est. $${formatRevenue(rev)}`);
				const estimateStr = estimates.length > 0 ? ` — ${estimates.join(", ")}` : "";
				earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}${estimateStr}`);
			}
		} else if (event.event_type === "dividend") {
			const amount = event.data.cashAmount as number;
			const payDate = event.data.payDate as string | null;
			if (channel === "sms") {
				dividendLines.push(`${event.symbol}: ex-div ${dateLabel} $${amount.toFixed(2)}`);
			} else {
				const payStr = payDate ? ` (pays ${payDate.slice(5)})` : "";
				const freq = event.data.frequency as number | null;
				const freqStr = freq && FREQUENCY_LABELS[freq] ? `, ${FREQUENCY_LABELS[freq]}` : "";
				dividendLines.push(
					`${event.symbol}: ex-div ${dateLabel} — $${amount.toFixed(2)}/share${payStr}${freqStr}`,
				);
			}
		} else if (event.event_type === "split") {
			const splitFrom = event.data.splitFrom as number;
			const splitTo = event.data.splitTo as number;
			const adjType = event.data.adjustmentType as string;
			const ratio = formatSplitRatio(splitFrom, splitTo, adjType);
			if (channel === "sms") {
				splitLines.push(`${event.symbol}: split ${dateLabel} ${ratio}`);
			} else {
				const isReverse = adjType === "reverse_split" || splitTo < splitFrom;
				const numericRatio = isReverse ? `${splitFrom}:${splitTo}` : `${splitTo}:${splitFrom}`;
				const typeLabel = isReverse ? "reverse split" : "forward split";
				splitLines.push(`${event.symbol}: split ${dateLabel} — ${numericRatio} ${typeLabel}`);
			}
		} else if (event.event_type === "ipo") {
			const issuer = event.data.issuerName as string | undefined;
			if (channel === "sms") {
				ipoLines.push(`${event.symbol}: IPO ${dateLabel}`);
			} else {
				const issuerSuffix = issuer ? ` — ${issuer}` : "";
				ipoLines.push(`${event.symbol}: IPO ${dateLabel}${issuerSuffix}`);
			}
		}
	}

	return {
		earnings: earningsLines.length > 0 ? earningsLines.join("\n") : null,
		dividends: dividendLines.length > 0 ? dividendLines.join("\n") : null,
		splits: splitLines.length > 0 ? splitLines.join("\n") : null,
		ipos: ipoLines.length > 0 ? ipoLines.join("\n") : null,
	};
}

/** Format analyst recommendation trend data as a channel-appropriate text block. */
export function formatAnalystSection(
	data: Map<string, RecommendationTrend | null>,
	channel: DeliveryChannel,
): string | null {
	const lines: string[] = [];
	for (const [symbol, trend] of data) {
		if (!trend) continue;
		if (channel === "sms") {
			lines.push(`${symbol}: ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell`);
		} else {
			lines.push(
				`${symbol}: ${trend.strongBuy} Strong Buy, ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell, ${trend.strongSell} Strong Sell (${trend.period})`,
			);
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Format a share count compactly (e.g. 1200 -> "1k"). */
function formatShareCount(shares: number): string {
	const abs = Math.abs(shares);
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}k`;
	return abs.toLocaleString("en-US");
}

/** Format insider transaction data as a channel-appropriate text block. */
export function formatInsiderSection(
	data: Map<string, InsiderTransaction[]>,
	channel: DeliveryChannel,
): string | null {
	const lines: string[] = [];
	const maxPerTicker = channel === "sms" ? 2 : 5;

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
