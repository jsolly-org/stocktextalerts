import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { adminClient } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

/**
 * Verifies reserve/finalize semantics of `reserve_flat_price_alert`:
 * - Sub-threshold moves return false
 * - First-of-day insert succeeds when no state row exists
 * - Re-trigger succeeds when baseline matches current row (optimistic lock)
 * - Re-trigger fails when baseline no longer matches (race lost)
 * - Concurrent claims with identical params: exactly one wins
 */
describe("reserve_flat_price_alert RPC", () => {
	it("Dollar unit: a +$7 move (+3.5%) reserves against a $5 threshold — true ONLY if the dollar unit is honored", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		// Discriminating fixture: $200 → $207 = +$7 but only +3.5%, so a
		// percent-read of the 5 would return false; dollar must return true.
		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 200,
			p_new_price: 207,
			p_threshold_value: 5,
			p_threshold_unit: "dollar",
		});

		expect(error).toBeNull();
		expect(data).toBe(true);
	});

	it("Unknown threshold unit fails closed (false, no row)", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 100,
			p_new_price: 150,
			p_threshold_value: 5,
			p_threshold_unit: "bogus",
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

	it("Sub-threshold move (+4.99%) returns false and creates no row", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 100,
			p_new_price: 104.99,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
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

	it("First-of-day +5.3% reserve creates pending row without committing price until finalize", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price, pending_delivery, pending_new_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(186.0, 2);
		expect(state?.pending_delivery).toBe(true);
		expect(Number(state?.pending_new_price)).toBeCloseTo(195.86, 2);

		const { data: finalized, error: finalizeError } = await adminClient.rpc(
			"finalize_flat_price_alert",
			{
				p_user_id: testUser.id,
				p_symbol: "AAPL",
			},
		);
		expect(finalizeError).toBeNull();
		expect(finalized).toBe(true);

		const { data: committed } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price, pending_delivery")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(committed?.last_notification_price)).toBeCloseTo(195.86, 2);
		expect(committed?.pending_delivery).toBe(false);
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
		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 195.86,
			p_new_price: 206.04,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price, pending_delivery, pending_new_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(195.86, 2);
		expect(state?.pending_delivery).toBe(true);
		expect(Number(state?.pending_new_price)).toBeCloseTo(206.04, 2);

		await adminClient.rpc("finalize_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
		});

		const { data: committed } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(committed?.last_notification_price)).toBeCloseTo(206.04, 2);
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
		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 195.86,
			p_new_price: 217.0,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
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
		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
		});

		expect(error).toBeNull();
		expect(data).toBe(true);

		const { data: state } = await adminClient
			.from("price_move_alert_state")
			.select("last_notification_price, pending_delivery, pending_new_price")
			.eq("user_id", testUser.id)
			.eq("symbol", "AAPL")
			.single();

		expect(Number(state?.last_notification_price)).toBeCloseTo(150.0, 2);
		expect(state?.pending_delivery).toBe(true);
		expect(Number(state?.pending_new_price)).toBeCloseTo(195.86, 2);
	});

	it("Five concurrent first-of-day reserves: exactly one wins", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const concurrency = 5;
		const args = {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 186.0,
			p_new_price: 195.86,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
		};

		const results = await Promise.all(
			Array.from({ length: concurrency }, () => adminClient.rpc("reserve_flat_price_alert", args)),
		);

		const errors = results.filter((r) => r.error);
		expect(errors).toHaveLength(0);

		const successCount = results.filter((r) => r.data === true).length;
		expect(successCount).toBe(1);
	});

	it("Invalid inputs (zero baseline) return false", async () => {
		const testUser = await createTestUser({ trackedAssets: ["AAPL"] });
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("reserve_flat_price_alert", {
			p_user_id: testUser.id,
			p_symbol: "AAPL",
			p_baseline_price: 0,
			p_new_price: 195.86,
			p_threshold_value: 5,
			p_threshold_unit: "percent",
		});

		expect(error).toBeNull();
		expect(data).toBe(false);
	});
});
