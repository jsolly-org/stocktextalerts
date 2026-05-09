import { afterAll, describe, expect, it } from "vitest";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("market-times migration: post-conversion bounds and idempotency", () => {
	const cleanup: (() => Promise<void>)[] = [];

	afterAll(async () => {
		for (const fn of cleanup) await fn();
	});

	it("The CHECK constraint accepts the lower extended-hours bound (270 = 4:30 AM ET).", async () => {
		const { id } = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_times: [270] })
			.eq("id", id);

		expect(error).toBeNull();
	});

	it("The CHECK constraint accepts the upper extended-hours bound (1170 = 7:30 PM ET).", async () => {
		const { id } = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_times: [1170] })
			.eq("id", id);

		expect(error).toBeNull();
	});

	it("The CHECK constraint rejects a minute below the lower bound (269).", async () => {
		const { id } = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_times: [269] })
			.eq("id", id);

		expect(error).not.toBeNull();
		expect(error?.message ?? "").toMatch(/check/i);
	});

	it("The CHECK constraint rejects a minute above the upper bound (1171).", async () => {
		const { id } = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(id);

		const { error } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_times: [1171] })
			.eq("id", id);

		expect(error).not.toBeNull();
		expect(error?.message ?? "").toMatch(/check/i);
	});

	it("The migration sentinel is in place after db:reset (idempotency guard ready for re-runs).", async () => {
		const { data, error } = await adminClient
			.from("app_metadata")
			.select("value")
			.eq("key", "market_times_storage")
			.single();

		expect(error).toBeNull();
		expect(data?.value).toBe("et_minutes");
	});
});
