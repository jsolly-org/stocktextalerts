import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { CURATED_PREDICTION_MARKETS } from "./catalog";
import type { CuratedPredictionMarket, PredictionMarketReading } from "./types";
import { kalshiMarketUrl, polymarketMarketUrl } from "./urls";

function parseYesProbabilityPercent(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		// Kalshi dollars are 0–1; Polymarket outcomePrices are 0–1 strings/numbers.
		const asPercent = raw <= 1 ? raw * 100 : raw;
		if (asPercent < 0 || asPercent > 100) return null;
		return Math.round(asPercent * 10) / 10;
	}
	if (typeof raw === "string" && raw.trim() !== "") {
		const n = Number(raw);
		return Number.isFinite(n) ? parseYesProbabilityPercent(n) : null;
	}
	return null;
}

function parsePolymarketYesPrice(market: Record<string, unknown>): number | null {
	const outcomePrices = market.outcomePrices;
	let prices: unknown = outcomePrices;
	if (typeof outcomePrices === "string") {
		try {
			prices = JSON.parse(outcomePrices) as unknown;
		} catch {
			return null;
		}
	}
	if (!Array.isArray(prices) || prices.length === 0) {
		return parseYesProbabilityPercent(market.lastTradePrice ?? market.bestBid);
	}
	return parseYesProbabilityPercent(prices[0]);
}

type VenueReading = {
	probabilityPercent: number;
	url: string;
};

function polymarketEventSlug(row: Record<string, unknown>): string | null {
	if (typeof row.eventSlug === "string" && row.eventSlug.trim() !== "") {
		return row.eventSlug.trim();
	}
	const events = row.events;
	if (Array.isArray(events) && events.length > 0 && isRecord(events[0])) {
		const slug = events[0].slug;
		if (typeof slug === "string" && slug.trim() !== "") return slug.trim();
	}
	return null;
}

async function fetchPolymarketReading(
	market: Extract<CuratedPredictionMarket, { venue: "polymarket" }>,
	logger: Logger,
): Promise<VenueReading | null> {
	const slug = market.polymarketSlug;

	const payload = await polymarketFetch("/markets", { slug }, `prediction-market:${market.key}`, {
		optional: true,
	});
	if (payload === null) return null;

	const row = Array.isArray(payload) ? payload[0] : payload;
	if (!isRecord(row)) {
		logger.warn("Polymarket market response missing row", { marketKey: market.key, slug });
		return null;
	}
	if (row.closed === true || row.active === false) {
		logger.info("Polymarket curated market inactive", {
			marketKey: market.key,
			slug,
			closed: row.closed ?? null,
			active: row.active ?? null,
		});
		return null;
	}
	const probabilityPercent = parsePolymarketYesPrice(row);
	if (probabilityPercent === null) {
		logger.warn("Polymarket curated market missing Yes price", { marketKey: market.key, slug });
		return null;
	}
	return {
		probabilityPercent,
		url: polymarketMarketUrl(slug, polymarketEventSlug(row)),
	};
}

async function fetchKalshiReading(
	market: Extract<CuratedPredictionMarket, { venue: "kalshi" }>,
	logger: Logger,
): Promise<VenueReading | null> {
	const ticker = market.kalshiTicker;

	const payload = await kalshiFetch(
		`/markets/${encodeURIComponent(ticker)}`,
		{},
		`prediction-market:${market.key}`,
		{ optional: true },
	);
	if (payload === null) return null;

	const row = isRecord(payload) && isRecord(payload.market) ? payload.market : payload;
	if (!isRecord(row)) {
		logger.warn("Kalshi market response missing row", { marketKey: market.key, ticker });
		return null;
	}
	const status = typeof row.status === "string" ? row.status : null;
	if (status !== null && status !== "active" && status !== "open") {
		logger.info("Kalshi curated market inactive", { marketKey: market.key, ticker, status });
		return null;
	}

	// Prefer mid of bid/ask when both present; else last trade / yes bid.
	const yesBid = parseYesProbabilityPercent(row.yes_bid_dollars);
	const yesAsk = parseYesProbabilityPercent(row.yes_ask_dollars);
	const probabilityPercent =
		yesBid !== null && yesAsk !== null
			? Math.round(((yesBid + yesAsk) / 2) * 10) / 10
			: (parseYesProbabilityPercent(row.last_price_dollars) ??
				yesBid ??
				yesAsk ??
				parseYesProbabilityPercent(row.yes_bid) ??
				null);
	if (probabilityPercent === null) {
		logger.warn("Kalshi curated market missing Yes price", { marketKey: market.key, ticker });
		return null;
	}

	const eventTicker = typeof row.event_ticker === "string" ? row.event_ticker : null;
	return {
		probabilityPercent,
		url: kalshiMarketUrl(ticker, eventTicker),
	};
}

/**
 * Fetch current Yes probabilities for the curated strip.
 * Soft-fails per market (optional vendors) — returns only successful readings.
 * Markets are fetched in parallel so a slow venue doesn't serialize the strip.
 */
export async function fetchCuratedPredictionMarketReadings(options: {
	logger: Logger;
}): Promise<PredictionMarketReading[]> {
	const { logger } = options;

	const settled = await Promise.all(
		CURATED_PREDICTION_MARKETS.map(async (market): Promise<PredictionMarketReading | null> => {
			const venueReading =
				market.venue === "polymarket"
					? await fetchPolymarketReading(market, logger)
					: await fetchKalshiReading(market, logger);
			if (venueReading === null) return null;
			return {
				key: market.key,
				label: market.label,
				venue: market.venue,
				probabilityPercent: venueReading.probabilityPercent,
				deltaPoints: null,
				url: venueReading.url,
			};
		}),
	);

	return settled.filter((reading): reading is PredictionMarketReading => reading !== null);
}
