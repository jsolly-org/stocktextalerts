import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
	NOTIFICATION_BUDGET_GLOBAL_DAILY,
	NOTIFICATION_BUDGET_PRICE_MOVE_DAILY,
} from "../../../src/lib/notification-budget/constants";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

async function todayEtBudget(userId: string) {
	const todayEt = DateTime.now().setZone("America/New_York").toISODate();
	if (!todayEt) throw new Error("Failed to format ET date");
	const { data, error } = await adminClient
		.from("notification_budget")
		.select("global_count, price_move_count")
		.eq("user_id", userId)
		.eq("window_date", todayEt)
		.maybeSingle();
	if (error) throw new Error(error.message);
	return data;
}

describe("try_consume_notification_budget / release_notification_budget RPC", () => {
	it("consumes price_move against both local and global counters", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "price_move_alerts",
			p_count: 1,
		});
		expect(error).toBeNull();
		expect(data).toBe(true);

		const row = await todayEtBudget(testUser.id);
		expect(row).toEqual({ global_count: 1, price_move_count: 1 });
	});

	it("market/daily kinds increment global only", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const market = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "market_scheduled_asset_price",
		});
		expect(market.error).toBeNull();
		expect(market.data).toBe(true);

		const daily = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "daily_notification",
		});
		expect(daily.error).toBeNull();
		expect(daily.data).toBe(true);

		const row = await todayEtBudget(testUser.id);
		expect(row).toEqual({ global_count: 2, price_move_count: 0 });
	});

	it("rejects unknown kind (fail closed)", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const { data, error } = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "delisting",
		});
		expect(error).toBeNull();
		expect(data).toBe(false);
		expect(await todayEtBudget(testUser.id)).toBeNull();
	});

	it("hits the price-move local cap of 20", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const todayEt = DateTime.now().setZone("America/New_York").toISODate();
		if (!todayEt) throw new Error("Failed to format ET date");
		const { error: seedError } = await adminClient.from("notification_budget").insert({
			user_id: testUser.id,
			window_date: todayEt,
			global_count: NOTIFICATION_BUDGET_PRICE_MOVE_DAILY,
			price_move_count: NOTIFICATION_BUDGET_PRICE_MOVE_DAILY,
		});
		expect(seedError).toBeNull();

		const { data, error } = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "price_move_alerts",
		});
		expect(error).toBeNull();
		expect(data).toBe(false);

		expect(await todayEtBudget(testUser.id)).toEqual({
			global_count: NOTIFICATION_BUDGET_PRICE_MOVE_DAILY,
			price_move_count: NOTIFICATION_BUDGET_PRICE_MOVE_DAILY,
		});

		// Scheduled kinds can still consume remaining global headroom (40-20=20).
		const market = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "market_scheduled_asset_price",
		});
		expect(market.error).toBeNull();
		expect(market.data).toBe(true);
	});

	it("hits the global cap of 40 for scheduled and price-move kinds", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const todayEt = DateTime.now().setZone("America/New_York").toISODate();
		if (!todayEt) throw new Error("Failed to format ET date");
		const { error: seedError } = await adminClient.from("notification_budget").insert({
			user_id: testUser.id,
			window_date: todayEt,
			global_count: NOTIFICATION_BUDGET_GLOBAL_DAILY,
			price_move_count: 0,
		});
		expect(seedError).toBeNull();

		const daily = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "daily_notification",
		});
		expect(daily.error).toBeNull();
		expect(daily.data).toBe(false);

		const priceMove = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "price_move_alerts",
		});
		expect(priceMove.error).toBeNull();
		expect(priceMove.data).toBe(false);
		expect(await todayEtBudget(testUser.id)).toEqual({
			global_count: NOTIFICATION_BUDGET_GLOBAL_DAILY,
			price_move_count: 0,
		});
	});

	it("release restores counters after a failed send", async () => {
		const testUser = await createTestUser();
		registerTestUserForCleanup(testUser.id);

		const consumed = await adminClient.rpc("try_consume_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "price_move_alerts",
			p_count: 2,
		});
		expect(consumed.error).toBeNull();
		expect(consumed.data).toBe(true);
		expect(await todayEtBudget(testUser.id)).toEqual({
			global_count: 2,
			price_move_count: 2,
		});

		const released = await adminClient.rpc("release_notification_budget", {
			p_user_id: testUser.id,
			p_kind: "price_move_alerts",
			p_count: 2,
		});
		expect(released.error).toBeNull();
		expect(await todayEtBudget(testUser.id)).toEqual({
			global_count: 0,
			price_move_count: 0,
		});
	});
});
