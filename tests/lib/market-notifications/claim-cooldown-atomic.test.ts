import { describe, expect, it } from "vitest";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Verifies that concurrent cooldown claims for the same user+symbol are atomic:
 * only one caller succeeds, preventing duplicate alerts under overlapping cron ticks.
 * Exercises `claim_market_asset_price_alert_slot` RPC (INSERT ... ON CONFLICT DO UPDATE)
 * with five parallel calls sharing identical params; exactly one must return true.
 */
describe("Claim cooldown atomicity under concurrency", () => {
	it("Concurrent claims for same user+symbol: exactly one succeeds (first_only)", async () => {
		const testUser = await createTestUser({
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const concurrency = 5;
		const args = {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_abs_move_percent: 5,
			p_abs_move_dollar: 10,
		};

		const results = await Promise.all(
			Array.from({ length: concurrency }, () =>
				adminClient.rpc("claim_market_asset_price_alert_slot", args),
			),
		);

		const errors = results.filter((r) => r.error);
		expect(errors).toHaveLength(0);
		const claimed = results.map((r) => Boolean(r.data));
		const successCount = claimed.filter(Boolean).length;

		expect(successCount).toBe(1);
		expect(claimed).toHaveLength(concurrency);
	});
});
