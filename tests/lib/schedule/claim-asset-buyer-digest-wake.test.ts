import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { adminClient } from "../../helpers/test-env";

describe("claim_asset_buyer_digest_wake RPC", () => {
	it("returns true once per ET date then false on the retry", async () => {
		const seed = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
		const date = DateTime.fromISO("2200-01-01")
			.plus({ days: seed % 50_000 })
			.toISODate();
		expect(date).toBeTruthy();
		if (!date) throw new Error("expected ISO date");

		const first = await adminClient.rpc("claim_asset_buyer_digest_wake", { p_et_date: date });
		expect(first.error).toBeNull();
		expect(first.data).toBe(true);

		const second = await adminClient.rpc("claim_asset_buyer_digest_wake", { p_et_date: date });
		expect(second.error).toBeNull();
		expect(second.data).toBe(false);
	});

	it("release clears the claim so the same ET date can be claimed again", async () => {
		const seed = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
		const date = DateTime.fromISO("2200-01-01")
			.plus({ days: seed % 50_000 })
			.toISODate();
		expect(date).toBeTruthy();
		if (!date) throw new Error("expected ISO date");

		const first = await adminClient.rpc("claim_asset_buyer_digest_wake", { p_et_date: date });
		expect(first.error).toBeNull();
		expect(first.data).toBe(true);

		const released = await adminClient.rpc("release_asset_buyer_digest_wake", { p_et_date: date });
		expect(released.error).toBeNull();
		expect(released.data).toBe(true);

		const retry = await adminClient.rpc("claim_asset_buyer_digest_wake", { p_et_date: date });
		expect(retry.error).toBeNull();
		expect(retry.data).toBe(true);
	});
});
