import type {
	AssetPriceMap,
	ExtendedAssetQuote,
	ExtendedQuoteMap,
	MarketSession,
	NoSessionTrade,
} from "../types";
import { fetchLiveQuotes } from "./quotes";
import type { AssetPricesWithSessionState } from "./types";

/**
 * Fetch live quotes for a list of symbols and return a map keyed by symbol.
 *
 * `session` is threaded through so `fetchLiveQuotes` can distinguish a symbol that hasn't
 * traded this active session (surfaced as `NO_SESSION_TRADE`) from a genuine miss. It is
 * resolved once per scheduler tick and passed down — no per-call session lookup.
 */
export async function fetchAssetPrices(
	symbols: string[],
	session: MarketSession,
): Promise<AssetPriceMap> {
	const quotes = await fetchLiveQuotes(symbols, session);
	return narrowQuotesToPriceMap(quotes);
}

/**
 * Like `fetchAssetPrices`, but also returns the set of symbols recognized with no live trade
 * for the current session. Used by the scheduled-notification renderer to show "no pre-market
 * trades" instead of the generic "price unavailable" for illiquid tickers.
 */
export async function fetchAssetPricesWithSessionState(
	symbols: string[],
	session: MarketSession,
): Promise<AssetPricesWithSessionState> {
	const quotes = await fetchLiveQuotes(symbols, session);
	return splitQuotesByNoSessionTrade(quotes);
}

function narrowQuotesToPriceMap(
	quotes: Map<string, ExtendedAssetQuote | NoSessionTrade | null>,
): ExtendedQuoteMap {
	const result: ExtendedQuoteMap = new Map();
	for (const [symbol, entry] of quotes) {
		result.set(symbol, entry === "no_session_trade" ? null : entry);
	}
	return result;
}

function splitQuotesByNoSessionTrade(
	quotes: Map<string, ExtendedAssetQuote | NoSessionTrade | null>,
): {
	prices: ExtendedQuoteMap;
	noSessionTrade: Set<string>;
} {
	const prices: ExtendedQuoteMap = new Map();
	const noSessionTrade = new Set<string>();
	for (const [symbol, entry] of quotes) {
		if (entry === "no_session_trade") {
			prices.set(symbol, null);
			noSessionTrade.add(symbol);
		} else {
			prices.set(symbol, entry);
		}
	}
	return { prices, noSessionTrade };
}

/**
 * Fetch extended quotes for symbols (day high/low/open/prevClose; volume is null under
 * Finnhub `/quote`). Same underlying fetch as `fetchAssetPrices` — the extended fields ride
 * along on every quote.
 */
export async function fetchExtendedQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<ExtendedQuoteMap> {
	const quotes = await fetchLiveQuotes(symbols, session);
	return narrowQuotesToPriceMap(quotes);
}
