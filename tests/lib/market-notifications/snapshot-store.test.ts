import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { purgeOldAssetSnapshots } from "../../../src/lib/market-notifications/snapshot-store";
import { getAssetData } from "../../helpers/asset-data";
import { upsertAssets } from "../../helpers/asset-db";
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
			await upsertAssets([{ symbol: asset.symbol, name: asset.name, type: asset.type }]);

			// Clean up any pre-existing snapshots for this symbol (from other tests)
			const { error: cleanupError } = await adminClient
				.from("asset_snapshots")
				.delete()
				.eq("symbol", asset.symbol);
			expect(cleanupError).toBeNull();

			// Fixed timestamps — purge RPC uses Postgres NOW(), not JS Date.
			const recentCapturedAt = "2099-06-01T12:00:00.000Z";
			const staleCapturedAt = "2000-01-01T00:00:00.000Z";

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

			// Postgres may normalize timestamptz formatting on read; sort by epoch instead.
			const sortedByCapturedAt = [...insertedRows!].sort(
				(a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime(),
			);
			expect(sortedByCapturedAt).toHaveLength(2);
			const staleRow = sortedByCapturedAt[0]!;
			const recentRow = sortedByCapturedAt[1]!;
			expect(new Date(staleRow.captured_at).getTime()).toBe(new Date(staleCapturedAt).getTime());
			expect(new Date(recentRow.captured_at).getTime()).toBe(new Date(recentCapturedAt).getTime());

			const purged = await purgeOldAssetSnapshots(adminClient);
			expect(purged).toBeGreaterThanOrEqual(1);

			const insertedIds = (insertedRows ?? []).map((row) => row.id);

			// Scope to rows this test inserted (shared DB can retain other rows for the symbol).
			const { data: remaining, error: selectError } = await adminClient
				.from("asset_snapshots")
				.select("id,symbol,captured_at")
				.in("id", insertedIds);

			expect(selectError).toBeNull();
			expect(remaining).toHaveLength(1);
			const remainingRow = remaining![0]!;
			expect(remainingRow.id).toBe(recentRow.id);
			expect(remainingRow.symbol).toBe(asset.symbol);
			expect(new Date(remainingRow.captured_at).getTime()).toBe(
				new Date(recentCapturedAt).getTime(),
			);
		} finally {
			// Clean up test data
			await adminClient.from("asset_snapshots").delete().eq("symbol", asset.symbol);
		}
	});
});
