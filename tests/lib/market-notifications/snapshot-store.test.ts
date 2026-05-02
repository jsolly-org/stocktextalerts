import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	purgeOldAssetSnapshots,
	RETENTION_MINUTES,
} from "../../../src/lib/market-notifications/snapshot-store";
import { getAssetData } from "../../helpers/asset-data";
import { adminClient } from "../../helpers/test-env";

describe("snapshot-store purge", () => {
	it("purgeOldAssetSnapshots deletes rows older than retention window", async () => {
		const uniqueSymbol = `S${randomUUID().replace(/-/g, "").slice(0, 9)}`;
		const assetData = getAssetData("AAPL");
		const asset = {
			symbol: uniqueSymbol,
			name: `Snapshot Test ${uniqueSymbol}`,
			type: assetData.type,
		};

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
			const recentCapturedAt = now.toISOString();
			const staleCapturedAt = new Date(
				now.getTime() - (RETENTION_MINUTES + 10) * 60 * 1000,
			).toISOString();

			const { data: insertedRows, error: insertError } = await adminClient
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
						captured_at: recentCapturedAt,
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
						captured_at: staleCapturedAt,
					},
				])
				.select("id,captured_at");

			expect(insertError).toBeNull();
			expect(insertedRows).toHaveLength(2);

			const staleRow = insertedRows?.find(
				(row) => new Date(row.captured_at).getTime() === new Date(staleCapturedAt).getTime(),
			);
			expect(staleRow).toBeDefined();

			const purged = await purgeOldAssetSnapshots(adminClient);
			expect(purged).toBeGreaterThanOrEqual(0);

			// Recent snapshot should remain
			const { data: remaining, error: selectError } = await adminClient
				.from("asset_snapshots")
				.select("id,symbol,captured_at")
				.eq("symbol", asset.symbol);

			expect(selectError).toBeNull();
			expect(remaining).toHaveLength(1);
			expect(remaining?.[0]?.symbol).toBe(asset.symbol);
			expect(new Date(remaining?.[0]?.captured_at ?? 0).getTime()).toBeGreaterThanOrEqual(
				new Date(recentCapturedAt).getTime(),
			);
			expect(remaining?.[0]?.id).not.toBe(staleRow?.id);
			const retentionCutoffIso = new Date(
				now.getTime() - RETENTION_MINUTES * 60 * 1000,
			).toISOString();
			expect(remaining?.[0]?.captured_at >= retentionCutoffIso).toBe(true);
		} finally {
			// Clean up test data
			await adminClient.from("asset_snapshots").delete().eq("symbol", asset.symbol);
		}
	});
});
