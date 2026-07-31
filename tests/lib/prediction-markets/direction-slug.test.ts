import { describe, expect, it } from "vitest";
import {
	nextEtWeekdayDates,
	polymarketDailyDirectionSlug,
} from "../../../src/lib/prediction-markets/direction-slug";
import { hasFutureDailyDirectionMarket } from "../../../src/lib/prediction-markets/select";
import type { PredictionMarketEventCard } from "../../../src/lib/prediction-markets/types";

describe("polymarketDailyDirectionSlug", () => {
	it("builds the Polymarket daily up/down slug", () => {
		expect(polymarketDailyDirectionSlug("PLTR", "2026-07-31")).toBe(
			"pltr-up-or-down-on-july-31-2026",
		);
		expect(polymarketDailyDirectionSlug("NVDA", "2026-08-03")).toBe(
			"nvda-up-or-down-on-august-3-2026",
		);
	});
});

describe("nextEtWeekdayDates", () => {
	it("from Thu Jul 30 returns Fri Jul 31 then Mon Aug 3", () => {
		// 2026-07-30 16:00 UTC = noon ET Thursday
		const dates = nextEtWeekdayDates({
			nowMs: Date.parse("2026-07-30T16:00:00.000Z"),
			count: 3,
		});
		expect(dates[0]).toBe("2026-07-31");
		expect(dates[1]).toBe("2026-08-03");
		expect(dates[2]).toBe("2026-08-04");
	});
});

describe("hasFutureDailyDirectionMarket", () => {
	const nowMs = Date.parse("2026-07-30T16:00:00.000Z");

	function card(
		partial: Partial<PredictionMarketEventCard> & Pick<PredictionMarketEventCard, "key" | "title">,
	): PredictionMarketEventCard {
		return {
			venue: "polymarket",
			url: "https://example.com",
			shape: "binary",
			shapeValidated: true,
			volume: 100,
			closesAt: "2026-07-31T20:00:00.000Z",
			refreshedAt: new Date(nowMs).toISOString(),
			outcomes: [
				{
					venueContractId: "up",
					label: "Up",
					probabilityPercent: 55,
					sortOrder: 0,
					strikeValue: null,
					volume: 1,
				},
				{
					venueContractId: "down",
					label: "Down",
					probabilityPercent: 45,
					sortOrder: 1,
					strikeValue: null,
					volume: 1,
				},
			],
			...partial,
		};
	}

	it("is true for tomorrow's up/down and false for today or KPI", () => {
		expect(
			hasFutureDailyDirectionMarket(
				[
					card({
						key: "tomorrow",
						title: "Palantir (PLTR) Up or Down on July 31?",
						closesAt: "2026-07-31T20:00:00.000Z",
					}),
				],
				{ nowMs },
			),
		).toBe(true);

		expect(
			hasFutureDailyDirectionMarket(
				[
					card({
						key: "today",
						title: "Palantir (PLTR) Up or Down on July 30?",
						closesAt: "2026-07-30T20:00:00.000Z",
					}),
				],
				{ nowMs },
			),
		).toBe(false);

		expect(
			hasFutureDailyDirectionMarket(
				[
					card({
						key: "kpi",
						title: "Palantir KPI",
						closesAt: "2026-08-15T00:00:00.000Z",
						matchKind: "kpi",
						outcomes: [
							{
								venueContractId: "yes",
								label: "Yes",
								probabilityPercent: 80,
								sortOrder: 0,
								strikeValue: null,
								volume: 1,
							},
						],
					}),
				],
				{ nowMs },
			),
		).toBe(false);
	});
});
