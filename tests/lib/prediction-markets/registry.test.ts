import { describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createLogger } from "../../../src/lib/logging";
import {
	loadAcceptedMatchesForSymbols,
	persistDiscoveredMatches,
	stampPmDiscoveryCheckedAt,
} from "../../../src/lib/prediction-markets/registry";
import type { DiscoveredPredictionEvent } from "../../../src/lib/prediction-markets/types";

const logger = createLogger({ action: "prediction-markets-registry-test" });

const sampleEvent: DiscoveredPredictionEvent = {
	venue: "polymarket",
	venueEventId: "evt-1",
	seriesId: null,
	title: "What will NVIDIA (NVDA) hit?",
	url: "https://polymarket.com/event/nvda",
	matchKind: "direct_price",
	shape: "binary",
	shapeValidated: true,
	volume: 1000,
	closesAt: null,
	confidence: 90,
	evidence: { where: "title", alias: "NVDA" },
	highlightAlias: "NVDA",
	outcomes: [
		{
			venueContractId: "cond-1",
			label: "Yes",
			probabilityPercent: 42,
			sortOrder: 0,
			strikeValue: null,
			volume: 1000,
		},
		{
			venueContractId: "cond-1:no",
			label: "No",
			probabilityPercent: 58,
			sortOrder: 1,
			strikeValue: null,
			volume: 1000,
		},
	],
};

describe("persistDiscoveredMatches", () => {
	it("upserts event + outcomes + accepted match rows and rejects stale accepted matches", async () => {
		const matchUpsert = vi.fn(async () => ({ data: null, error: null }));
		const outcomeUpsert = vi.fn(async () => ({ data: null, error: null }));
		const rejectIn = vi.fn(async () => ({ data: null, error: null }));
		const outcomeDeleteIn = vi.fn(async () => ({ data: null, error: null }));
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
			if (table === "prediction_market_outcomes") {
				return {
					upsert: outcomeUpsert,
					select: () => ({
						eq: async () => ({
							data: [
								{ id: "keep-o", venue_contract_id: "cond-1" },
								{ id: "stale-o", venue_contract_id: "old" },
							],
							error: null,
						}),
					}),
					delete: () => ({
						in: outcomeDeleteIn,
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
			markets: [sampleEvent],
		});
		expect(stored).toBe(1);
		expect(from).toHaveBeenCalledWith("prediction_markets");
		expect(from).toHaveBeenCalledWith("prediction_market_outcomes");
		expect(from).toHaveBeenCalledWith("asset_prediction_market_matches");
		expect(matchUpsert).toHaveBeenCalled();
		expect(outcomeUpsert).toHaveBeenCalled();
		expect(rejectIn).toHaveBeenCalledWith("id", ["stale-row"]);
		expect(outcomeDeleteIn).toHaveBeenCalledWith("id", ["stale-o"]);
	});

	it("rejects prior accepted matches when discovery finds nothing", async () => {
		const decisionEq = vi.fn(async () => ({ data: null, error: null }));
		const from = vi.fn((table: string) => {
			if (table === "asset_prediction_market_matches") {
				return {
					update: () => ({
						eq: () => ({
							eq: decisionEq,
						}),
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
			markets: [],
		});
		expect(stored).toBe(0);
		expect(decisionEq).toHaveBeenCalled();
	});
});

describe("stampPmDiscoveryCheckedAt", () => {
	it("updates assets.pm_discovery_checked_at", async () => {
		const eq = vi.fn(async () => ({ data: null, error: null }));
		const from = vi.fn(() => ({
			update: () => ({ eq }),
		}));
		const supabase = { from } as unknown as SupabaseAdminClient;
		await stampPmDiscoveryCheckedAt(supabase, "NVDA");
		expect(from).toHaveBeenCalledWith("assets");
		expect(eq).toHaveBeenCalledWith("symbol", "NVDA");
	});
});

describe("loadAcceptedMatchesForSymbols", () => {
	it("maps joined event + outcomes into stored readings", async () => {
		const from = vi.fn(() => ({
			select: () => ({
				in: () => ({
					in: async () => ({
						data: [
							{
								symbol: "NVDA",
								match_kind: "direct_price",
								confidence: 90,
								evidence: { alias: "NVDA", highlightAlias: "NVDA" },
								prediction_markets: {
									venue: "polymarket",
									venue_market_id: "evt-1",
									label: "NVDA July",
									question: "What will NVIDIA hit?",
									url: "https://polymarket.com/event/nvda",
									probability_percent: 42,
									status: "open",
									match_kind: "direct_price",
									shape: "binary",
									shape_validated: true,
									shape_meta: { highlightAlias: "NVDA" },
									closes_at: null,
									refreshed_at: "2026-07-10T00:00:00.000Z",
									volume: 1000,
									prediction_market_outcomes: [
										{
											venue_contract_id: "yes",
											label: "Yes",
											probability_percent: 42,
											sort_order: 0,
											strike_value: null,
											volume: 1000,
										},
										{
											venue_contract_id: "no",
											label: "No",
											probability_percent: 58,
											sort_order: 1,
											strike_value: null,
											volume: 1000,
										},
									],
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
		expect(rows[0]?.key).toBe("polymarket:evt-1");
		expect(rows[0]?.shape).toBe("binary");
		expect(rows[0]?.outcomes).toHaveLength(2);
	});
});
