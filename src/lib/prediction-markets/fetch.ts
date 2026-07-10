import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { CURATED_PREDICTION_MARKETS } from "./catalog";
import type { CuratedPredictionMarket, PredictionMarketEventCard } from "./types";
import { kalshiMarketUrl, polymarketMarketUrl } from "./urls";

function parseYesProbabilityPercent(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
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
	closesAt: string | null;
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
	const closesAt =
		typeof row.endDate === "string"
			? row.endDate
			: typeof row.end_date_iso === "string"
				? row.end_date_iso
				: null;
	return {
		probabilityPercent,
		url: polymarketMarketUrl(slug, polymarketEventSlug(row)),
		closesAt,
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
	const closesAt =
		typeof row.close_time === "string"
			? row.close_time
			: typeof row.expected_expiration_time === "string"
				? row.expected_expiration_time
				: null;
	return {
		probabilityPercent,
		url: kalshiMarketUrl(ticker, eventTicker),
		closesAt,
	};
}

function toBinaryCard(
	market: CuratedPredictionMarket,
	reading: VenueReading,
): PredictionMarketEventCard {
	const yes = reading.probabilityPercent;
	const no = Math.round((100 - yes) * 10) / 10;
	return {
		key: market.key,
		title: market.label,
		venue: market.venue,
		url: reading.url,
		shape: "binary",
		closesAt: reading.closesAt,
		refreshedAt: new Date().toISOString(),
		volume: 0,
		shapeValidated: true,
		outcomes: [
			{
				venueContractId: `${market.key}:yes`,
				label: "Yes",
				probabilityPercent: yes,
				sortOrder: 0,
				strikeValue: null,
				volume: 0,
			},
			{
				venueContractId: `${market.key}:no`,
				label: "No",
				probabilityPercent: no,
				sortOrder: 1,
				strikeValue: null,
				volume: 0,
			},
		],
	};
}

/**
 * Fetch curated macro markets as binary event cards (same grammar as assets).
 * Soft-fails per market — returns only successful cards.
 */
export async function fetchCuratedPredictionMarketCards(options: {
	logger: Logger;
}): Promise<PredictionMarketEventCard[]> {
	const { logger } = options;

	const settled = await Promise.all(
		CURATED_PREDICTION_MARKETS.map(async (market): Promise<PredictionMarketEventCard | null> => {
			const venueReading =
				market.venue === "polymarket"
					? await fetchPolymarketReading(market, logger)
					: await fetchKalshiReading(market, logger);
			if (venueReading === null) return null;
			return toBinaryCard(market, venueReading);
		}),
	);

	return settled.filter((card): card is PredictionMarketEventCard => card !== null);
}
