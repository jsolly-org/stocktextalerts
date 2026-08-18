import { describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../src/lib/db/supabase";
import { purgeOldPriceHistoryCache } from "../../../src/lib/market-data/price-history-cache";
import { errorSpy, expectConsoleError, warnMessages } from "../../setup";

const GATEWAY_ERROR = { message: "Internal server error." };
const STATEMENT_TIMEOUT = {
	message: "canceling statement due to statement timeout",
	code: "57014",
};

function supabaseWithPurgeErrors(errors: {
	priceHistory?: object | null;
	dailyCloses?: object | null;
}): SupabaseAdminClient {
	const rpc = vi.fn(async (fn: string) => {
		if (fn === "purge_old_asset_price_history") {
			return { data: null, error: errors.priceHistory ?? null };
		}
		if (fn === "purge_old_asset_daily_closes") {
			return { data: null, error: errors.dailyCloses ?? null };
		}
		return { data: 0, error: null };
	});
	return { rpc } as unknown as SupabaseAdminClient;
}

describe("purgeOldPriceHistoryCache log level", () => {
	it("A gateway-shaped Internal server error on both purge RPCs warns and does not error.", async () => {
		const supabase = supabaseWithPurgeErrors({
			priceHistory: GATEWAY_ERROR,
			dailyCloses: GATEWAY_ERROR,
		});

		await expect(purgeOldPriceHistoryCache(supabase)).resolves.toEqual({
			minutePurged: 0,
			dailyPurged: 0,
		});

		expect(warnMessages()).toEqual([
			"Failed to purge asset_price_history",
			"Failed to purge asset_daily_closes",
		]);
		expect(errorSpy.mock.calls).toEqual([]);
	});

	it("A Postgres statement timeout on a purge RPC still logs error.", async () => {
		expectConsoleError("Failed to purge asset_price_history");
		const supabase = supabaseWithPurgeErrors({
			priceHistory: STATEMENT_TIMEOUT,
			dailyCloses: null,
		});

		await expect(purgeOldPriceHistoryCache(supabase)).resolves.toEqual({
			minutePurged: 0,
			dailyPurged: 0,
		});

		expect(errorSpy.mock.calls).toHaveLength(1);
		const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
		expect(payload.level).toBe("error");
		expect(payload.error.raw.code).toBe("57014");
	});
});
