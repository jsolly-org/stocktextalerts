import type { CuratedPredictionMarket } from "./types";

/**
 * Hand-curated macro prediction markets for the daily digest weather strip.
 *
 * Order is the display order. Keys are stable snapshot IDs — do not rename.
 * When a market resolves/closes, replace the venue id/slug but keep the key
 * (or retire the entry) so history stays coherent.
 *
 * Mix of Kalshi (CFTC-regulated econ) and Polymarket (liquid crowd markets).
 */
export const CURATED_PREDICTION_MARKETS: readonly CuratedPredictionMarket[] = [
	{
		key: "recession_2026",
		label: "Recession '26",
		venue: "kalshi",
		kalshiTicker: "KXRECSSNBER-26",
	},
	{
		key: "fed_cut_by_2027",
		label: "Fed cut by '27",
		venue: "kalshi",
		kalshiTicker: "KXRATECUT-26DEC31",
	},
	{
		key: "fed_cut_by_dec_2026",
		label: "Fed cut by Dec",
		venue: "polymarket",
		polymarketSlug: "fed-rate-cut-by-december-2026-meeting",
	},
	{
		key: "spx_best_2026",
		label: "S&P best '26",
		venue: "polymarket",
		polymarketSlug: "will-the-sp-500-have-the-best-performance-in-2026-545",
	},
	{
		key: "us_china_tariff_deal",
		label: "US–China tariff deal",
		venue: "polymarket",
		polymarketSlug: "us-x-china-tariff-agreement-by-december-31",
	},
	{
		key: "iran_nuclear_deal_eoy",
		label: "US–Iran nuclear deal",
		venue: "polymarket",
		polymarketSlug: "us-iran-final-nuclear-deal-by-december-31-2026",
	},
] as const;
