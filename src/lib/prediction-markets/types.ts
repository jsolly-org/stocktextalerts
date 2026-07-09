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

/** Live reading for one market (macro or asset-linked). */
export type PredictionMarketReading = {
	key: string;
	label: string;
	venue: PredictionMarketVenue;
	/** Implied Yes probability in percentage points (0–100). */
	probabilityPercent: number;
	/** Change vs the previous stored snapshot, in percentage points; null if none. */
	deltaPoints: number | null;
	/** Public venue page for the market (email/Telegram deep link). */
	url: string;
	/** Present for asset-linked rows; omitted for curated macro. */
	symbol?: string;
	matchKind?: PredictionMatchKind;
};

/** Grouped digest payload: asset markets first, then curated macro. */
export type PredictionMarketsDigestContent = {
	assetMarkets: PredictionMarketReading[];
	macroMarkets: PredictionMarketReading[];
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

/** Candidate market before ranking / persistence. */
export type DiscoveredPredictionMarket = {
	venue: PredictionMarketVenue;
	venueMarketId: string;
	eventId: string | null;
	seriesId: string | null;
	label: string;
	question: string;
	url: string;
	matchKind: PredictionMatchKind;
	probabilityPercent: number | null;
	volume: number;
	closesAt: string | null;
	confidence: number;
	evidence: IdentityEvidence;
};

/** Digest-ready row loaded from accepted asset matches. */
export type StoredAssetMatchReading = {
	key: string;
	symbol: string;
	label: string;
	venue: PredictionMarketVenue;
	matchKind: PredictionMatchKind;
	probabilityPercent: number;
	url: string;
	confidence: number;
};

export const MATCHER_VERSION = "f1";

/** Stable odds-history key for a discovered venue market. */
export function assetPredictionMarketKey(
	venue: PredictionMarketVenue,
	venueMarketId: string,
): string {
	return `${venue}:${venueMarketId}`;
}
