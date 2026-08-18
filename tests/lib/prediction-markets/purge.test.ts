import { describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import { purgeOldPredictionMarketOdds } from "../../../src/lib/prediction-markets/store";

function mockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

describe("purgeOldPredictionMarketOdds log level", () => {
	it("A gateway-shaped Internal server error warns and does not error.", async () => {
		const logger = mockLogger();
		const rpc = vi.fn(async () => ({
			data: null,
			error: { message: "Internal server error." },
		}));
		const supabase = { rpc } as unknown as SupabaseAdminClient;

		await expect(purgeOldPredictionMarketOdds(supabase, logger)).resolves.toBe(0);
		expect(logger.warn).toHaveBeenCalledWith(
			"Failed to purge prediction_market_odds",
			{ retentionDays: 30 },
			{ message: "Internal server error." },
		);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("A Postgres statement timeout still logs error.", async () => {
		const logger = mockLogger();
		const timeout = {
			message: "canceling statement due to statement timeout",
			code: "57014",
		};
		const rpc = vi.fn(async () => ({ data: null, error: timeout }));
		const supabase = { rpc } as unknown as SupabaseAdminClient;

		await expect(purgeOldPredictionMarketOdds(supabase, logger)).resolves.toBe(0);
		expect(logger.error).toHaveBeenCalledWith(
			"Failed to purge prediction_market_odds",
			{ retentionDays: 30 },
			timeout,
		);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
