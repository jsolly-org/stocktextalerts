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

/** Live reading for one curated market. */
export type PredictionMarketReading = {
	key: string;
	label: string;
	venue: CuratedPredictionMarket["venue"];
	/** Implied Yes probability in percentage points (0–100). */
	probabilityPercent: number;
	/** Change vs the previous stored snapshot, in percentage points; null if none. */
	deltaPoints: number | null;
	/** Public venue page for the market (email/Telegram deep link). */
	url: string;
};
