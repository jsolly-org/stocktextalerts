import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

/**
 * Verifies the atomic claim semantics of `claim_flat_price_alert`:
 * - Sub-threshold moves return false
 * - First-of-day insert succeeds when no state row exists
 * - Re-trigger succeeds when baseline matches current row (optimistic lock)
 * - Re-trigger fails when baseline no longer matches (race lost)
 * - Concurrent claims with identical params: exactly one wins
 */
describe("claim_flat_price_alert RPC", () => {
	it("Sub-threshold move (+4.99%) returns false and creates no row", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 100,
			p_new_price: 104.99,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(false);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("*")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL");

		expect(state).toHaveLength(0);
	});

	it("First-of-day +5.3% move inserts state row and returns true", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(195.86, 2);
	});

	it("Re-trigger with matching baseline updates the row and returns true", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		// Seed state row from a first-of-day alert
		await adminClient.from("price_move_alert_state").insert({
			user_id: testUser.id,
			symbol: "AAPL",
			last_notification_price: 195.86,
			last_notification_at: new Date().toISOString(),
		});

		// Price moves another 5.2% from 195.86 to 206.04
		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 195.86,
			p_new_price: 206.04,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(206.04, 2);
	});

	it("Race lost: stale baseline no longer matches row, returns false", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		// Another tick already upserted to 206.04
		await adminClient.from("price_move_alert_state").insert({
			user_id: testUser.id,
			symbol: "AAPL",
			last_notification_price: 206.04,
			last_notification_at: new Date().toISOString(),
		});

		// This caller still thinks the baseline is 195.86 (stale read)
		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 195.86,
			p_new_price: 217.0,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(false);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		// Row untouched from the earlier insert
		expect(Number(state?.last_notification_price)).toBeCloseTo(206.04, 2);
	});

	it("Stale row from yesterday (ET) is overwritten unconditionally", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		// Seed a row with last_notification_at set to 3 days ago (definitely stale ET-wise)
		const threeDaysAgo = DateTime.now().minus({ days: 3 }).toISO();
		await adminClient.from("price_move_alert_state").insert({
			user_id: testUser.id,
			symbol: "AAPL",
			last_notification_price: 150.0,
			last_notification_at: threeDaysAgo,
		});

		// Today's first-of-day alert uses prev_close as baseline. Row should refresh
		// even though `baseline_price (186) != row.last_notification_price (150)`,
		// because the row is from a previous trading day.
		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(195.86, 2);
	});

	it("Five concurrent first-of-day claims: exactly one wins", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const concurrency = 5;
		const args = {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_percent: 5,
		};

		const results = await Promise.all(
			Array.from({ length: concurrency }, () =>
				adminClient.rpc("claim_flat_price_alert", args),
			),
		);

		const errors = results.filter((r) => r.error);
		expect(errors).toHaveLength(0);

		const successCount = results.filter((r) => r.data === true).length;
		expect(successCount).toBe(1);
	});

	it("Invalid inputs (zero baseline) return false", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("claim_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 0,
			p_new_price: 195.86,
			p_threshold_percent: 5,
		});

		expect(error).toBeNull();
		expect(data).toBe(false);
	});
});
