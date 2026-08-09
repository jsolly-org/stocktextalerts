/**
 * Content-tracked symbols: email/telegram holders only — lambda (stock-buyer)
 * and disabled-only holdings must not inflate PM/enrichment maintenance.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadDistinctContentTrackedSymbols } from "../../../src/lib/db/user-assets";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
const HUMAN_ONLY = `${PREFIX}H1`;
const LAMBDA_ONLY = `${PREFIX}L1`;
const SHARED = `${PREFIX}S1`;
const DISABLED_ONLY = `${PREFIX}D1`;

const symbols = [HUMAN_ONLY, LAMBDA_ONLY, SHARED, DISABLED_ONLY];

async function track(userId: string, symbolList: string[]): Promise<void> {
	const { error } = await adminClient
		.from("user_assets")
		.insert(symbolList.map((symbol) => ({ user_id: userId, symbol })));
	if (error) throw new Error(`user_assets insert failed: ${error.message}`);
}

describe("loadDistinctContentTrackedSymbols", () => {
	const cleanupUserIds: string[] = [];

	afterEach(async () => {
		for (const id of cleanupUserIds.splice(0)) {
			await adminClient.from("user_assets").delete().eq("user_id", id);
			await adminClient.auth.admin.deleteUser(id);
		}
		await deleteAssets(symbols);
	});

	it("includes email/telegram holdings and shared tickers; excludes lambda-only and disabled-only", async () => {
		await upsertAssets(
			symbols.map((symbol) => ({ symbol, name: `${symbol} Co`, type: "stock" as const })),
		);

		const human = await createTestUser({ deliveryChannel: "email", confirmed: true });
		registerTestUserForCleanup(human.id);
		cleanupUserIds.push(human.id);
		await track(human.id, [HUMAN_ONLY, SHARED]);

		const buyer = await createTestUser({ deliveryChannel: "lambda", confirmed: true });
		registerTestUserForCleanup(buyer.id);
		cleanupUserIds.push(buyer.id);
		await track(buyer.id, [LAMBDA_ONLY, SHARED]);

		const disabled = await createTestUser({ deliveryChannel: "disabled", confirmed: true });
		registerTestUserForCleanup(disabled.id);
		cleanupUserIds.push(disabled.id);
		await track(disabled.id, [DISABLED_ONLY]);

		const tracked = await loadDistinctContentTrackedSymbols({ supabase: adminClient });
		const ours = tracked.filter((s) => symbols.includes(s));

		expect(ours).toContain(HUMAN_ONLY);
		expect(ours).toContain(SHARED);
		expect(ours).not.toContain(LAMBDA_ONLY);
		expect(ours).not.toContain(DISABLED_ONLY);
	});
});
