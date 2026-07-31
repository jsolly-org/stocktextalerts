/**
 * Optional live curated Macro Weather fetch against Kalshi + Polymarket.
 * Excluded from default Vitest (see vitest.config.ts). Run explicitly:
 *   LIVE_PREDICTION_MARKETS=1 npx vitest run tests/lib/prediction-markets/fetch.live.test.ts
 *
 * Post-deploy CI uses stocktextalerts-live-provider-check instead.
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
const liveEnabled = process.env.LIVE_PREDICTION_MARKETS === "1";

describe.skipIf(!liveEnabled)("live curated prediction markets", () => {
	it("fetches catalog markets as structured Yes/No or Up/Down binaries", async () => {
		const cards = await fetchCuratedPredictionMarketCards({ logger });
		const requiredKeys = CURATED_PREDICTION_MARKETS.filter((m) => !m.allowInactive).map(
			(m) => m.key,
		);
		const gotKeys = new Set(cards.map((c) => c.key));

		expect(cards.length).toBeGreaterThan(0);
		for (const key of requiredKeys) {
			expect(gotKeys.has(key), `missing required curated key ${key}`).toBe(true);
		}

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
		expect(digest).toContain("Fed cut by '27");
		expect(digest).not.toContain("Recession '26");
	}, 30_000);

	it("keeps SPX curated market on Up/Down when active", async () => {
		const cards = await fetchCuratedPredictionMarketCards({ logger });
		const spx = cards.find((c) => c.key === "spx_opens_up_down");
		if (!spx) return; // allowInactive — skip when dated slug has resolved
		expect(spx.outcomes.map((o) => o.label).sort()).toEqual(["Down", "Up"]);
		expect(formatPredictionMarketsDigestText({ assetCards: [], macroCards: cards })).toContain(
			"S&P 500 up/down",
		);
	}, 30_000);
});
