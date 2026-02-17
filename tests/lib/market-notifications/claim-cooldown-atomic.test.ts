import { describe, expect, it } from "vitest";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Verifies that concurrent cooldown claims for the same user+symbol are atomic:
 * only one caller succeeds, preventing duplicate alerts under overlapping cron ticks.
 */
describe("Claim cooldown atomicity under concurrency", () => {
	it("Concurrent claims for same user+symbol: exactly one succeeds (first_only)", async () => {
		const testUser = await createTestUser({
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const concurrency = 5;
		const observedAt = "2026-02-17T15:30:00Z";
		const args = {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_observed_at: observedAt,
			p_abs_move_percent: 5,
			p_abs_move_dollar: 10,
			p_allow_acceleration_follow_up: false,
			p_allow_recovery_follow_up: false,
			p_move_direction: "down" as const,
		};

		const results = await Promise.all(
			Array.from({ length: concurrency }, () =>
				adminClient.rpc("claim_market_asset_price_alert_slot", args),
			),
		);

		const claimed = results.filter((r) => !r.error).map((r) => Boolean(r.data));
		const successCount = claimed.filter(Boolean).length;

		expect(successCount).toBe(1);
		expect(claimed).toHaveLength(concurrency);
	});
});
