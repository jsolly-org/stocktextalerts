import type { Logger } from "../logging";
import { isRecord } from "../types";
import { kalshiFetch } from "../vendors/kalshi";
import { polymarketFetch } from "../vendors/polymarket";
import { CURATED_PREDICTION_MARKETS } from "./catalog";
import type {
	CuratedPredictionMarket,
	PredictionMarketEventCard,
	PredictionMarketOutcome,
} from "./types";
import { kalshiMarketUrl, polymarketMarketUrl } from "./urls";

function parseProbabilityPercent(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const asPercent = raw <= 1 ? raw * 100 : raw;
		if (asPercent < 0 || asPercent > 100) return null;
		return Math.round(asPercent * 10) / 10;
	}
	if (typeof raw === "string" && raw.trim() !== "") {
		const n = Number(raw);
		return Number.isFinite(n) ? parseProbabilityPercent(n) : null;
	}
	return null;
}

function parseJsonArray(raw: unknown): unknown[] | null {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return null;
}

function parseOutcomeLabels(market: Record<string, unknown>): string[] {
	const outcomes = parseJsonArray(market.outcomes);
	if (!outcomes) return [];
	return outcomes.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function parseOutcomePrices(market: Record<string, unknown>): number[] {
	const prices = parseJsonArray(market.outcomePrices);
	if (!prices) return [];
	return prices.map((p) => parseProbabilityPercent(p)).filter((p): p is number => p !== null);
}

type VenueReading = {
	url: string;
	closesAt: string | null;
	outcomes: PredictionMarketOutcome[];
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

function binaryOutcomesFromSide(
	marketKey: string,
	primaryLabel: string,
	secondaryLabel: string,
	primaryPercent: number,
): PredictionMarketOutcome[] {
	const secondary = Math.round((100 - primaryPercent) * 10) / 10;
	return [
		{
			venueContractId: `${marketKey}:${primaryLabel.toLowerCase()}`,
			label: primaryLabel,
			probabilityPercent: primaryPercent,
			sortOrder: 0,
			strikeValue: null,
			volume: 0,
		},
		{
			venueContractId: `${marketKey}:${secondaryLabel.toLowerCase()}`,
			label: secondaryLabel,
			probabilityPercent: secondary,
			sortOrder: 1,
			strikeValue: null,
			volume: 0,
		},
	];
}

function binaryOutcomesFromPolymarketRow(
	marketKey: string,
	row: Record<string, unknown>,
): PredictionMarketOutcome[] | null {
	const labels = parseOutcomeLabels(row);
	const prices = parseOutcomePrices(row);
	if (labels.length >= 2 && prices.length >= 2 && prices[0] != null && prices[1] != null) {
		return [
			{
				venueContractId: `${marketKey}:0`,
				label: labels[0] ?? "Yes",
				probabilityPercent: prices[0],
				sortOrder: 0,
				strikeValue: null,
				volume: 0,
			},
			{
				venueContractId: `${marketKey}:1`,
				label: labels[1] ?? "No",
				probabilityPercent: prices[1],
				sortOrder: 1,
				strikeValue: null,
				volume: 0,
			},
		];
	}

	const primary = prices[0] ?? parseProbabilityPercent(row.lastTradePrice ?? row.bestBid);
	if (primary === null) return null;
	return binaryOutcomesFromSide(marketKey, "Yes", "No", primary);
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
	const outcomes = binaryOutcomesFromPolymarketRow(market.key, row);
	if (outcomes === null) {
		logger.warn("Polymarket curated market missing outcome prices", {
			marketKey: market.key,
			slug,
		});
		return null;
	}
	const closesAt =
		typeof row.endDate === "string"
			? row.endDate
			: typeof row.end_date_iso === "string"
				? row.end_date_iso
				: null;
	return {
		outcomes,
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

	const yesBid = parseProbabilityPercent(row.yes_bid_dollars);
	const yesAsk = parseProbabilityPercent(row.yes_ask_dollars);
	const probabilityPercent =
		yesBid !== null && yesAsk !== null
			? Math.round(((yesBid + yesAsk) / 2) * 10) / 10
			: (parseProbabilityPercent(row.last_price_dollars) ??
				yesBid ??
				yesAsk ??
				parseProbabilityPercent(row.yes_bid) ??
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
		outcomes: binaryOutcomesFromSide(market.key, "Yes", "No", probabilityPercent),
		url: kalshiMarketUrl(ticker, eventTicker),
		closesAt,
	};
}

function toBinaryCard(
	market: CuratedPredictionMarket,
	reading: VenueReading,
): PredictionMarketEventCard {
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
		outcomes: reading.outcomes,
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
