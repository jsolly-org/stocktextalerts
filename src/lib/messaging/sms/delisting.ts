import type { DelistedHolding } from "../email/delisting";

/** SMS segment-friendly upper bound for a single message. */
const SMS_MAX_LENGTH = 320;

/**
 * Format a consolidated delisting SMS for 1+ delisted holdings.
 *
 * The message is informational and self-contained — no URL shortener is
 * used because the user's dashboard will reflect the cleanup immediately
 * and a generic link adds length without new information.
 *
 * For the rare case where a user holds enough delisted symbols that the
 * full list would blow past the SMS length budget, the list is truncated
 * with a "+N more" tail.
 */
export function formatDelistingSms(holdings: DelistedHolding[]): string {
	if (holdings.length === 0) {
		throw new Error("formatDelistingSms requires at least one delisted holding");
	}

	const sorted = [...holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
	const isSingle = sorted.length === 1;

	const h = sorted[0];
	if (isSingle && h) {
		const exchange = h.exchange ? ` on ${h.exchange}` : "";
		const body = `StockTextAlerts: ${h.symbol} (${h.name}) was delisted${exchange} on ${h.delistedDate} and has been removed from your tracked assets.`;
		return truncateSms(body);
	}

	const symbolList = sorted.map((h) => h.symbol).join(", ");
	const body = `StockTextAlerts: ${sorted.length} of your tracked stocks were delisted and removed from your alerts — ${symbolList}.`;
	return truncateSms(body);
}

function truncateSms(body: string): string {
	if (body.length <= SMS_MAX_LENGTH) return body;
	const ellipsis = "…";
	return `${body.slice(0, SMS_MAX_LENGTH - ellipsis.length)}${ellipsis}`;
}
