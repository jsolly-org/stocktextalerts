/**
 * Tests for shared schedule helpers — specifically the delisted-asset
 * filter added to batchLoadUserAssets as defense in depth so the price
 * fetcher never sees a delisted holding even during the brief window
 * between Massive detecting the delisting and the daily sweep cleaning
 * up the user_assets row.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import {
	batchLoadUserAssets,
	claimNotification,
	MAX_NOTIFICATION_RETRIES,
} from "../../../src/lib/schedule/helpers";
import { assertIsoDateString, assertMinuteOfDay } from "../../../src/lib/types";
import { computeDeliveryRetryDelayMs } from "../../../src/lib/vendors/vendor-fault-tolerance";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../setup";

describe("claimNotification surfaces the claim RPC's post-claim attempt_count", () => {
	it("returns status 'claimed' with the attempt_count the RPC reports (no re-SELECT needed)", async () => {
		// The RPC now returns the post-claim attempt_count (>= 1) instead of a bare boolean,
		// so the failed-delivery path can compute the backoff without re-reading the row.
		const supabase = {
			rpc: async () => ({ data: 3, error: null }),
		} as never;
		const result = await claimNotification({
			supabase,
			userId: "00000000-0000-0000-0000-000000000001",
			notificationType: "daily",
			scheduledDate: assertIsoDateString("2026-06-24"),
			scheduledMinutes: assertMinuteOfDay(540),
			channel: "email",
			logger: rootLogger,
		});
		expect(result).toEqual({ status: "claimed", attemptCount: 3 });
	});

	it("returns 'claim_error' when the claim RPC errors", async () => {
		expectConsoleError("Failed to claim daily notification (email)");
		const supabase = {
			rpc: async () => ({ data: null, error: { message: "boom" } }),
		} as never;
		const result = await claimNotification({
			supabase,
			userId: "00000000-0000-0000-0000-000000000002",
			notificationType: "daily",
			scheduledDate: assertIsoDateString("2026-06-24"),
			scheduledMinutes: assertMinuteOfDay(540),
			channel: "email",
			logger: rootLogger,
		});
		expect(result).toEqual({ status: "claim_error" });
	});

	it("drives the real claim_scheduled_notification state machine: fresh→1, re-claim denied, retry→2, ceiling→exhausted", async () => {
		// DB-backed coverage of the migration itself (the risky half of F4): the recreated RPC must
		// return the post-claim attempt_count on a win, NULL on every denied state, and increment on
		// a real retry — a mock that hard-codes the return value can't catch the RPC saying it wrong.
		// The ceiling step logs the terminal-failure alarm at error level (expected here).
		expectConsoleError("Retries exhausted; will retry next local day");
		const user = await createTestUser();
		registerTestUserForCleanup(user.id);
		const base = {
			supabase: adminClient,
			userId: user.id,
			notificationType: "daily" as const,
			scheduledDate: assertIsoDateString("2026-06-24"),
			scheduledMinutes: assertMinuteOfDay(540),
			channel: "email" as const,
			logger: rootLogger,
		};

		// Fresh claim wins; the RPC returns the post-claim attempt_count 1.
		expect(await claimNotification(base)).toEqual({ status: "claimed", attemptCount: 1 });

		// Immediate re-claim: the row is 'sending', < 10 min old, attempt_count 1 < 3 → RPC denies.
		expect((await claimNotification(base)).status).toBe("not_ready");

		// Mark it failed and clear the backoff; the next claim is eligible and increments to 2.
		await adminClient
			.from("scheduled_notifications")
			.update({ status: "failed", next_retry_at: null })
			.eq("user_id", user.id)
			.eq("notification_type", "daily")
			.eq("scheduled_date", "2026-06-24")
			.eq("scheduled_minutes", 540)
			.eq("channel", "email");
		expect(await claimNotification(base)).toEqual({ status: "claimed", attemptCount: 2 });

		// At the retry ceiling the claim is denied and classified terminal (retries_exhausted).
		await adminClient
			.from("scheduled_notifications")
			.update({ status: "failed", attempt_count: MAX_NOTIFICATION_RETRIES, next_retry_at: null })
			.eq("user_id", user.id)
			.eq("notification_type", "daily")
			.eq("scheduled_date", "2026-06-24")
			.eq("scheduled_minutes", 540)
			.eq("channel", "email");
		expect((await claimNotification(base)).status).toBe("retries_exhausted");
	});
});

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
