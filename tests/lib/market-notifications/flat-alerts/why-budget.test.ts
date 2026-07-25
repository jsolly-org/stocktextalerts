import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAdminClient } from "../../../../src/lib/db/supabase";
import type { Logger } from "../../../../src/lib/logging";
import {
	claimPriceMoveWhyBudget,
	PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW,
} from "../../../../src/lib/market-notifications/flat-alerts/why-budget";

describe("claimPriceMoveWhyBudget", () => {
	const logger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when the RPC claims a slot", async () => {
		const rpc = vi.fn(async () => ({ data: true, error: null }));
		const supabase = { rpc } as unknown as SupabaseAdminClient;

		await expect(claimPriceMoveWhyBudget(supabase, "user-1", logger)).resolves.toBe(true);
		expect(rpc).toHaveBeenCalledWith("claim_price_move_why_budget", {
			p_user_id: "user-1",
		});
		expect(PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW).toBe(20);
	});

	it("returns false when the cap is reached", async () => {
		const rpc = vi.fn(async () => ({ data: false, error: null }));
		const supabase = { rpc } as unknown as SupabaseAdminClient;

		await expect(claimPriceMoveWhyBudget(supabase, "user-1", logger)).resolves.toBe(false);
	});

	it("returns false and logs on RPC error", async () => {
		const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
		const supabase = { rpc } as unknown as SupabaseAdminClient;

		await expect(claimPriceMoveWhyBudget(supabase, "user-1", logger)).resolves.toBe(false);
		expect(logger.error).toHaveBeenCalled();
	});
});
