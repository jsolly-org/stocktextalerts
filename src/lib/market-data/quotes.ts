import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import type { ExtendedAssetQuote, MarketSession, NoSessionTrade } from "../types";
import { isRecord, NO_SESSION_TRADE } from "../types";
import { finnhubFetch } from "../vendors/finnhub";

const QUOTE_FETCH_CONCURRENCY = 5;

/** Finnhub `/quote` payload: current, change, change%, high, low, open, prev-close, unix-seconds. */
interface FinnhubQuote {
	c?: number;
	d?: number;
	dp?: number;
	h?: number;
	l?: number;
	o?: number;
	pc?: number;
	t?: number;
}

function positiveOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Map a Finnhub `/quote` payload to an `ExtendedAssetQuote`, the `NO_SESSION_TRADE` sentinel,
 * or `null`.
 *
 * - `null` — unknown symbol (Finnhub returns `c: 0, t: 0`) or no price anchor for a %change.
 * - `NO_SESSION_TRADE` — an ACTIVE session whose last trade is dated before today (ET): the
 *   symbol hasn't printed this session (illiquid pre/after-hours). A `closed` market never
 *   yields the sentinel — the quote is the freshest close available.
 *
 * KNOWN RISK (verify post-deploy, risk #1 in the migration plan): this assumes Finnhub `/quote`
 * updates `c`/`t` for pre/after-hours trades. If the free tier only refreshes on regular-session
 * trades, every symbol goes stale-dated pre-market → `NO_SESSION_TRADE`, and after-hours shows
 * the locked 4pm close. Confirm with a live pre-market `/quote` on a liquid ticker.
 */
function parseFinnhubQuote(
	payload: unknown,
	session: MarketSession,
): ExtendedAssetQuote | NoSessionTrade | null {
	if (!isRecord(payload)) return null;
	const quote = payload as FinnhubQuote;

	const price = positiveOrNull(quote.c);
	if (price === null) return null;

	const lastTradeSeconds =
		typeof quote.t === "number" && Number.isFinite(quote.t) && quote.t > 0 ? quote.t : null;

	// A priced quote with no usable trade timestamp skips the staleness check and is returned
	// live (with a null timestamp) — better than fabricating a "no session trade" from a
	// missing `t`.
	if (session !== "closed" && lastTradeSeconds !== null) {
		const tradeDate = DateTime.fromSeconds(lastTradeSeconds)
			.setZone(US_MARKET_TIMEZONE)
			.toISODate();
		const todayEt = DateTime.now().setZone(US_MARKET_TIMEZONE).toISODate();
		if (tradeDate !== null && todayEt !== null && tradeDate < todayEt) {
			return NO_SESSION_TRADE;
		}
	}

	const prevClose = positiveOrNull(quote.pc);
	let changePercent: number;
	if (prevClose !== null) {
		// Derive from the displayed price + prior close rather than trusting `dp`, which can
		// disagree with `c`/`pc` on Finnhub (mirrors the prior Massive derivation).
		changePercent = ((price - prevClose) / prevClose) * 100;
	} else if (typeof quote.dp === "number" && Number.isFinite(quote.dp)) {
		changePercent = quote.dp;
	} else {
		return null;
	}

	return {
		price,
		changePercent,
		dayHigh: positiveOrNull(quote.h),
		dayLow: positiveOrNull(quote.l),
		dayOpen: positiveOrNull(quote.o),
		prevClose,
		timestamp: lastTradeSeconds,
		volume: null, // Finnhub `/quote` carries no volume.
	};
}

/**
 * Fetch live quotes for `symbols` from Finnhub `/quote` — one request per symbol, each gated
 * by the shared per-process Finnhub budget inside `finnhubFetch`. The returned map always
 * contains every requested symbol: a quote, the `NO_SESSION_TRADE` sentinel, or `null` (fetch
 * failed / unknown symbol / no price anchor). Per-symbol failure never affects the others.
 *
 * SCALING CEILING: one call per symbol against the ~55/min Finnhub budget means the watched
 * universe must stay under ~55 unique symbols per scheduler tick. Fine for this private
 * two-user app (~15–40 symbols; a tick's calls finish in ~1s so the window rolls clean before
 * the next `rate(1 minute)` tick). Past ~55 the limiter queues calls into the next minute and
 * alerts lag — revisit (batch source / dedicated budget / paid tier) before the universe grows.
 * The scheduler Lambda's duration metric + 300s timeout are the backstop if it's ever breached.
 */
export async function fetchLiveQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<Map<string, ExtendedAssetQuote | NoSessionTrade | null>> {
	const result = new Map<string, ExtendedAssetQuote | NoSessionTrade | null>();
	if (symbols.length === 0) return result;
	for (const symbol of symbols) result.set(symbol, null);

	const queue = [...symbols];
	// Count fetch failures (finnhubFetch returned null = network/outage), distinct from a
	// successful fetch that parses to null (unknown symbol → `c: 0`). Single-threaded workers
	// increment between awaits, so no race.
	let fetchFailures = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			// Optional: a single symbol exhausting retries logs at warn, not error — routine on
			// Finnhub's free tier and not worth paging the ErrorLogAlarm every minute.
			const payload = await finnhubFetch("/quote", { symbol }, "quote", { optional: true });
			if (payload === null) fetchFailures++;
			result.set(symbol, parseFinnhubQuote(payload, session));
		}
	}

	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(QUOTE_FETCH_CONCURRENCY, symbols.length); i++) {
		workers.push(worker());
	}
	await Promise.all(workers);

	// Every symbol's fetch failed → a real live-quote outage (not per-symbol flakiness, and not
	// merely unknown symbols) — page once. This is the "alerting is blind this tick" signal:
	// per-symbol failures are now warn-level, and the scheduler's own blind-tick page fires only
	// when the capture throws, which a null-returning outage does not.
	if (fetchFailures === symbols.length) {
		rootLogger.error("Finnhub /quote failed for every symbol — live quotes unavailable", {
			action: "fetch_live_quotes",
			symbolCount: symbols.length,
		});
	}

	return result;
}
