import { describe, expect, it } from "vitest";
import {
	purgeOldAssetSnapshots,
	RETENTION_MINUTES,
} from "../../../src/lib/market-notifications/snapshot-store";
import { getAssetData } from "../../helpers/asset-data";
import { adminClient } from "../../helpers/test-env";

describe("snapshot-store purge", () => {
	it("purgeOldAssetSnapshots deletes rows older than retention window", async () => {
		const asset = getAssetData("AAPL");

		try {
			// Ensure asset exists (required for FK)
			await adminClient
				.from("assets")
				.upsert(
					{ symbol: asset.symbol, name: asset.name, type: asset.type },
					{ onConflict: "symbol" },
				);

			// Clean up any pre-existing snapshots for this symbol (from other tests)
			const { error: cleanupError } = await adminClient
				.from("asset_snapshots")
				.delete()
				.eq("symbol", asset.symbol);
			expect(cleanupError).toBeNull();

			// Insert snapshots: one recent, one older than retention
			const now = new Date();
			const oldCutoff = new Date(
				now.getTime() - (RETENTION_MINUTES + 10) * 60 * 1000,
			).toISOString();

			const { error: insertError } = await adminClient
				.from("asset_snapshots")
				.insert([
					{
						symbol: asset.symbol,
						price: 150,
						change_percent: 1,
						day_high: 152,
						day_low: 148,
						day_open: 149,
						prev_close: 148.5,
						volume: null,
						captured_at: now.toISOString(),
					},
					{
						symbol: asset.symbol,
						price: 148,
						change_percent: -0.5,
						day_high: 152,
						day_low: 148,
						day_open: 149,
						prev_close: 148.5,
						volume: null,
						captured_at: oldCutoff,
					},
				]);

			expect(insertError).toBeNull();

			const purged = await purgeOldAssetSnapshots(adminClient);
			expect(purged).toBeGreaterThanOrEqual(1);

			// Recent snapshot should remain
			const { data: remaining, error: selectError } = await adminClient
				.from("asset_snapshots")
				.select("id,symbol,captured_at")
				.eq("symbol", asset.symbol);

			expect(selectError).toBeNull();
			expect(remaining).toHaveLength(1);
			// Recent snapshot (within retention) should remain; old one was purged
			expect(remaining?.[0]?.symbol).toBe(asset.symbol);
		} finally {
			// Clean up test data
			await adminClient
				.from("asset_snapshots")
				.delete()
				.eq("symbol", asset.symbol);
		}
	});
});
