import { buildPriceContext } from "../messaging/parts/asset-price-list";
import type { ExtendedAssetQuote, IntradayBarsResult } from "../types";
import type { EnrichedAlert } from "./types";

/** Build a minimal `EnrichedAlert` from flat-price-alert data for shared Telegram rendering. */
export function buildFlatAlertEnriched(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	triggerPercent: number;
	since: string;
	intraday: IntradayBarsResult | null;
}): EnrichedAlert {
	const { symbol, quote, triggerPercent, since, intraday } = options;
	return {
		symbol,
		priceContext: buildPriceContext(symbol, triggerPercent, quote.price, since),
		signalContext: "",
		grokContext: "",
		grokResult: null,
		intradayCloses: intraday?.closes ?? null,
		intradayTimestamps: intraday?.timestamps ?? null,
		intradayEndTimestamp: intraday?.endTimestamp ?? null,
		intradayCandles: intraday?.candles ?? null,
		prevClose: quote.prevClose,
		isPositiveMove: triggerPercent >= 0,
	};
}
