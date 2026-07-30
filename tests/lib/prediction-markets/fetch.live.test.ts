/**
 * Live curated Macro Weather fetch against Kalshi + Polymarket public APIs.
 * Asserts each card is a structured Yes/No or Up/Down binary — the digest contract.
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/lib/logging";
import {
	assertStructuredBinaryCard,
	isStructuredBinaryCard,
} from "../../../src/lib/prediction-markets/binary";
import { CURATED_PREDICTION_MARKETS } from "../../../src/lib/prediction-markets/catalog";
import { fetchCuratedPredictionMarketCards } from "../../../src/lib/prediction-markets/fetch";
import {
	formatEventCardText,
	formatPredictionMarketsDigestText,
} from "../../../src/lib/prediction-markets/format";

const logger = createLogger({ action: "prediction-markets-live-test" });

describe("live curated prediction markets", () => {
	it("fetches every catalog market as a structured Yes/No or Up/Down binary", async () => {
		const cards = await fetchCuratedPredictionMarketCards({ logger });

		expect(cards.length).toBe(CURATED_PREDICTION_MARKETS.length);
		expect(cards.map((c) => c.key).sort()).toEqual(
			[...CURATED_PREDICTION_MARKETS.map((m) => m.key)].sort(),
		);

		for (const card of cards) {
			expect(isStructuredBinaryCard(card), `${card.key} structure`).toBe(true);
			assertStructuredBinaryCard(card);

			const labels = card.outcomes.map((o) => o.label);
			const isYesNo = labels.includes("Yes") && labels.includes("No");
			const isUpDown = labels.includes("Up") && labels.includes("Down");
			expect(isYesNo || isUpDown, `${card.key} labels ${labels.join("/")}`).toBe(true);

			const text = formatEventCardText(card);
			expect(text).toContain(card.title);
			expect(text).not.toContain("Closes");
			expect(text).not.toContain("Updated");
			if (isYesNo) {
				expect(text).toContain("Yes");
				expect(text).toContain("No");
			} else {
				expect(text).toContain("Up");
				expect(text).toContain("Down");
			}
			expect(text).toMatch(/\d+%/);
			expect(text).toContain("█");
		}

		const digest = formatPredictionMarketsDigestText({ assetCards: [], macroCards: cards });
		expect(digest).toContain("Macro Weather");
		expect(digest).toContain("S&P 500 up/down");
		expect(digest).toContain("Fed cut by '27");
		expect(digest).not.toContain("Recession '26");
	}, 30_000);

	it("keeps SPX curated market on Up/Down (not Yes/No)", async () => {
		const cards = await fetchCuratedPredictionMarketCards({ logger });
		const spx = cards.find((c) => c.key === "spx_opens_up_down");
		expect(spx).toBeDefined();
		expect(spx?.outcomes.map((o) => o.label).sort()).toEqual(["Down", "Up"]);
	}, 30_000);
});
