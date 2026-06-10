/**
 * Tests for shared schedule helpers — specifically the delisted-asset
 * filter added to batchLoadUserAssets as defense in depth so the price
 * fetcher never sees a delisted holding even during the brief window
 * between Massive detecting the delisting and the daily sweep cleaning
 * up the user_assets row.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeliveryRetryDelayMs } from "../../../src/lib/providers/vendor-fault-tolerance";
import { batchLoadUserAssets } from "../../../src/lib/schedule/helpers";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("computeDeliveryRetryDelayMs", () => {
	it("returns exponential backoff steps capped at 60 minutes", () => {
		expect(computeDeliveryRetryDelayMs(1)).toBe(5 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(2)).toBe(15 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(3)).toBe(30 * 60 * 1000);
		expect(computeDeliveryRetryDelayMs(4)).toBe(60 * 60 * 1000);
	});
});

describe("batchLoadUserAssets delisted-asset filter", () => {
	const createdSymbols: string[] = [];

	afterEach(async () => {
		const symbols = createdSymbols.splice(0, createdSymbols.length);
		for (const symbol of symbols) {
			await adminClient.from("user_assets").delete().eq("symbol", symbol);
		}
		await deleteAssets(symbols);
	});

	it("skips delisted rows and only returns listed holdings.", async () => {
		const listed = `ZHL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
		const delisted = `ZDL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
		createdSymbols.push(listed, delisted);

		await upsertAssets([
			{ symbol: listed, name: "Listed Test Co", type: "stock" },
			{
				symbol: delisted,
				name: "Delisted Test Co",
				type: "stock",
				delisted_at: "2026-03-27T00:00:00+00:00",
			},
		]);

		const user = await createTestUser({
			email: `loader-filter-${randomUUID()}@example.com`,
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);

		await adminClient.from("user_assets").insert([
			{ user_id: user.id, symbol: listed },
			{ user_id: user.id, symbol: delisted },
		]);

		const map = await batchLoadUserAssets(adminClient, [user.id]);
		const assets = map.get(user.id) ?? [];

		const symbols = assets.map((a) => a.symbol);
		expect(symbols).toContain(listed);
		expect(symbols).not.toContain(delisted);
	});
});
