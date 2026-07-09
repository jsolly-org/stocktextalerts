/** Polymarket event page; deep-links to the market when an event slug is known. */
export function polymarketMarketUrl(marketSlug: string, eventSlug?: string | null): string {
	const market = marketSlug.trim();
	const event = eventSlug?.trim() || "";
	if (event && event !== market) {
		return `https://polymarket.com/event/${encodeURIComponent(event)}/${encodeURIComponent(market)}`;
	}
	return `https://polymarket.com/event/${encodeURIComponent(event || market)}`;
}

/**
 * Kalshi market page from ticker / event ticker.
 * Pattern: `https://kalshi.com/markets/{series}/{event}` (lowercase).
 */
export function kalshiMarketUrl(ticker: string, eventTicker?: string | null): string {
	const event = (eventTicker?.trim() || ticker).trim().toLowerCase();
	const series = event.split("-")[0] || event;
	return `https://kalshi.com/markets/${encodeURIComponent(series)}/${encodeURIComponent(event)}`;
}
