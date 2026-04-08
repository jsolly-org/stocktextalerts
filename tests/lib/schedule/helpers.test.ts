/**
 * Tests for shared schedule helpers — specifically the delisted-asset
 * filter added to batchLoadUserAssets as defense in depth so the price
 * fetcher never sees a delisted holding even during the brief window
 * between Massive detecting the delisting and the daily sweep cleaning
 * up the user_assets row.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { batchLoadUserAssets } from "../../../src/lib/schedule/helpers";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("batchLoadUserAssets delisted-asset filter", () => {
	const createdSymbols: string[] = [];

	afterEach(async () => {
		for (const symbol of createdSymbols.splice(0, createdSymbols.length)) {
			await adminClient.from("user_assets").delete().eq("symbol", symbol);
			await adminClient.from("assets").delete().eq("symbol", symbol);
		}
	});

	it("skips delisted rows and only returns listed holdings.", async () => {
		const listed = `ZHL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
		const delisted = `ZDL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
		createdSymbols.push(listed, delisted);

		const { error: insertErr } = await adminClient.from("assets").upsert([
			{ symbol: listed, name: "Listed Test Co", type: "stock" },
			{
				symbol: delisted,
				name: "Delisted Test Co",
				type: "stock",
				delisted_at: "2026-03-27T00:00:00+00:00",
			},
		]);
		expect(insertErr).toBeNull();

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
