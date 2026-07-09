import { describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createLogger } from "../../../src/lib/logging";
import {
	loadAcceptedMatchesForSymbols,
	persistDiscoveredMatches,
	stampPmDiscoveryCheckedAt,
} from "../../../src/lib/prediction-markets/registry";
import type { DiscoveredPredictionMarket } from "../../../src/lib/prediction-markets/types";

const logger = createLogger({ action: "prediction-markets-registry-test" });

const sampleMarket: DiscoveredPredictionMarket = {
	venue: "polymarket",
	venueMarketId: "cond-1",
	eventId: "evt-1",
	seriesId: null,
	label: "NVDA July",
	question: "What will NVIDIA (NVDA) hit?",
	url: "https://polymarket.com/event/nvda",
	matchKind: "direct_price",
	probabilityPercent: 42,
	volume: 1000,
	closesAt: null,
	confidence: 90,
	evidence: { where: "title", alias: "NVDA" },
};

describe("persistDiscoveredMatches", () => {
	it("upserts market + accepted match rows and rejects stale accepted matches", async () => {
		const matchUpsert = vi.fn(async () => ({ data: null, error: null }));
		const rejectIn = vi.fn(async () => ({ data: null, error: null }));
		const from = vi.fn((table: string) => {
			if (table === "prediction_markets") {
				return {
					upsert: () => ({
						select: () => ({
							single: async () => ({ data: { id: "pm-uuid-1" }, error: null }),
						}),
					}),
				};
			}
			if (table === "asset_prediction_market_matches") {
				return {
					upsert: matchUpsert,
					select: () => ({
						eq: () => ({
							eq: async () => ({
								data: [
									{ id: "keep-row", prediction_market_id: "pm-uuid-1" },
									{ id: "stale-row", prediction_market_id: "pm-old" },
								],
								error: null,
							}),
						}),
					}),
					update: () => ({
						in: rejectIn,
					}),
				};
			}
			throw new Error(`unexpected table ${table}`);
		});

		const supabase = { from } as unknown as SupabaseAdminClient;
		const stored = await persistDiscoveredMatches({
			supabase,
			logger,
			symbol: "NVDA",
			markets: [sampleMarket],
		});
		expect(stored).toBe(1);
		expect(from).toHaveBeenCalledWith("prediction_markets");
		expect(from).toHaveBeenCalledWith("asset_prediction_market_matches");
		expect(matchUpsert).toHaveBeenCalled();
		expect(rejectIn).toHaveBeenCalledWith("id", ["stale-row"]);
	});

	it("rejects prior accepted matches when discovery finds nothing", async () => {
		const decisionEq = vi.fn(async () => ({ data: null, error: null }));
		const symbolEq = vi.fn(() => ({ eq: decisionEq }));
		const from = vi.fn(() => ({
			update: () => ({ eq: symbolEq }),
		}));
		const supabase = { from } as unknown as SupabaseAdminClient;
		const stored = await persistDiscoveredMatches({
			supabase,
			logger,
			symbol: "NVDA",
			markets: [],
		});
		expect(stored).toBe(0);
		expect(from).toHaveBeenCalledWith("asset_prediction_market_matches");
		expect(symbolEq).toHaveBeenCalledWith("symbol", "NVDA");
		expect(decisionEq).toHaveBeenCalledWith("decision", "accepted");
	});
});

describe("stampPmDiscoveryCheckedAt", () => {
	it("updates assets.pm_discovery_checked_at", async () => {
		const eq = vi.fn(async () => ({ data: null, error: null }));
		const from = vi.fn(() => ({
			update: () => ({ eq }),
		}));
		const supabase = { from } as unknown as SupabaseAdminClient;
		await stampPmDiscoveryCheckedAt(supabase, "TSLA");
		expect(from).toHaveBeenCalledWith("assets");
		expect(eq).toHaveBeenCalledWith("symbol", "TSLA");
	});
});

describe("loadAcceptedMatchesForSymbols", () => {
	it("maps open accepted matches into digest readings and skips null odds", async () => {
		const from = vi.fn(() => ({
			select: () => ({
				in: () => ({
					in: async () => ({
						data: [
							{
								symbol: "NVDA",
								match_kind: "direct_price",
								confidence: 88,
								prediction_markets: {
									venue: "polymarket",
									venue_market_id: "c1",
									label: "July hit",
									url: "https://polymarket.com/event/nvda",
									probability_percent: 55,
									status: "open",
									match_kind: "direct_price",
								},
							},
							{
								symbol: "NVDA",
								match_kind: "kpi",
								confidence: 70,
								prediction_markets: {
									venue: "kalshi",
									venue_market_id: "KXNVDA-null",
									label: "no price",
									url: "https://kalshi.com/markets/kxnvda",
									probability_percent: null,
									status: "open",
									match_kind: "kpi",
								},
							},
							{
								symbol: "NVDA",
								match_kind: "kpi",
								confidence: 70,
								prediction_markets: {
									venue: "kalshi",
									venue_market_id: "KXNVDA-1",
									label: "closed",
									url: "https://kalshi.com/markets/kxnvda",
									probability_percent: 10,
									status: "closed",
									match_kind: "kpi",
								},
							},
						],
						error: null,
					}),
				}),
			}),
		}));
		const supabase = { from } as unknown as SupabaseAdminClient;
		const rows = await loadAcceptedMatchesForSymbols({
			supabase,
			logger,
			symbols: ["NVDA"],
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			key: "polymarket:c1",
			symbol: "NVDA",
			label: "NVDA: July hit",
			venue: "polymarket",
			matchKind: "direct_price",
			probabilityPercent: 55,
		});
	});
});
