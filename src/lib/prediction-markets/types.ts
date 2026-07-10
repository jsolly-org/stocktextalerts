/** One hand-curated macro market shown in the digest weather strip. */
export type CuratedPredictionMarket =
	| {
			/** Stable snapshot key (never rename — used as the odds-history PK). */
			key: string;
			/** Short label for the digest strip (e.g. "Recession '26"). */
			label: string;
			venue: "kalshi";
			/** Kalshi market ticker (binary Yes contract). */
			kalshiTicker: string;
	  }
	| {
			key: string;
			label: string;
			venue: "polymarket";
			/** Polymarket Gamma market slug (binary Yes/No). */
			polymarketSlug: string;
	  };

export type PredictionMarketVenue = CuratedPredictionMarket["venue"];

/** How a market relates to a tracked asset. */
export type PredictionMatchKind = "direct_price" | "kpi" | "company_subject";

/** Probability semantics for an event card body. */
export type PredictionMarketShape = "binary" | "exclusive" | "independent" | "threshold";

/** One outcome / contract leg inside an event. */
export type PredictionMarketOutcome = {
	venueContractId: string;
	label: string;
	probabilityPercent: number;
	sortOrder: number;
	/** Numeric strike for threshold ladders; null otherwise. */
	strikeValue: number | null;
	volume: number;
	/** True when this leg is the tracked-company highlight. */
	highlighted?: boolean;
};

/**
 * Digest-ready event card (asset-linked or macro).
 * Current-state only — no daily deltas.
 */
export type PredictionMarketEventCard = {
	key: string;
	title: string;
	venue: PredictionMarketVenue;
	url: string;
	shape: PredictionMarketShape;
	/** ISO close time; null = ongoing / no fixed close. */
	closesAt: string | null;
	/** ISO timestamp of the latest successful snapshot. */
	refreshedAt: string;
	volume: number;
	outcomes: PredictionMarketOutcome[];
	/** Present for asset-linked cards; omitted for curated macro. */
	symbol?: string;
	matchKind?: PredictionMatchKind;
	/** Shape validation passed (exclusive totals, etc.). */
	shapeValidated: boolean;
};

/** Grouped digest payload: asset cards first, then curated macro. */
export type PredictionMarketsDigestContent = {
	assetCards: PredictionMarketEventCard[];
	macroCards: PredictionMarketEventCard[];
};

/**
 * @deprecated Scalar reading kept for odds-history helpers during transition.
 * Prefer {@link PredictionMarketEventCard}.
 */
export type PredictionMarketReading = {
	key: string;
	label: string;
	venue: PredictionMarketVenue;
	probabilityPercent: number;
	deltaPoints: number | null;
	url: string;
	symbol?: string;
	matchKind?: PredictionMatchKind;
};

/** Identity strings used to discover and gate markets for one symbol. */
export type AssetIdentity = {
	symbol: string;
	name: string;
	aliases: string[];
};

/** Where identity matched for a discovered market. */
export type IdentityEvidence = {
	where: "title" | "outcome";
	alias: string;
};

/** One outcome discovered from a venue payload. */
export type DiscoveredPredictionOutcome = {
	venueContractId: string;
	label: string;
	probabilityPercent: number | null;
	sortOrder: number;
	strikeValue: number | null;
	volume: number;
};

/** Candidate event before ranking / persistence. */
export type DiscoveredPredictionEvent = {
	venue: PredictionMarketVenue;
	/** Stable venue event id (Poly slug / Kalshi event_ticker / single-market id). */
	venueEventId: string;
	seriesId: string | null;
	title: string;
	url: string;
	matchKind: PredictionMatchKind;
	shape: PredictionMarketShape;
	shapeValidated: boolean;
	volume: number;
	closesAt: string | null;
	confidence: number;
	evidence: IdentityEvidence;
	outcomes: DiscoveredPredictionOutcome[];
	/** Alias that should be force-highlighted in compressed views. */
	highlightAlias: string | null;
};

/** Digest-ready row loaded from accepted asset event matches. */
export type StoredAssetEventReading = {
	key: string;
	symbol: string;
	title: string;
	venue: PredictionMarketVenue;
	matchKind: PredictionMatchKind;
	shape: PredictionMarketShape;
	shapeValidated: boolean;
	url: string;
	closesAt: string | null;
	refreshedAt: string;
	volume: number;
	confidence: number;
	outcomes: PredictionMarketOutcome[];
	highlightAlias: string | null;
};

export const MATCHER_VERSION = "f2";

/** Cards older than this are omitted from the digest. */
export const PREDICTION_MARKET_STALE_MS = 48 * 60 * 60 * 1000;

/** Stable odds-history / storage key for a discovered venue event. */
export function assetPredictionEventKey(
	venue: PredictionMarketVenue,
	venueEventId: string,
): string {
	return `${venue}:${venueEventId}`;
}
