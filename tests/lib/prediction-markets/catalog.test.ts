import { describe, expect, it } from "vitest";
import { CURATED_PREDICTION_MARKETS } from "../../../src/lib/prediction-markets/catalog";

describe("CURATED_PREDICTION_MARKETS", () => {
	it("has unique stable keys and a venue-specific id for every entry", () => {
		const keys = CURATED_PREDICTION_MARKETS.map((m) => m.key);
		expect(new Set(keys).size).toBe(keys.length);

		for (const market of CURATED_PREDICTION_MARKETS) {
			if (market.venue === "polymarket") {
				expect(market.polymarketSlug).toBeTruthy();
			} else {
				expect(market.kalshiTicker).toBeTruthy();
			}
		}
	});
});
