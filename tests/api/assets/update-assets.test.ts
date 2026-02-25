import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { MAX_TRACKED_ASSETS } from "../../../src/lib/db/database-errors";
import { rootLogger } from "../../../src/lib/logging";
import { POST } from "../../../src/pages/api/assets/update";
import { getAssetData, getRealAssetSymbols } from "../../helpers/asset-data";
import { updateTrackedAssets } from "../../helpers/asset-update";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { allowConsoleErrors } from "../../setup";

describe("A signed-in user updates their tracked assets.", () => {
	it("A user cannot track more than the maximum allowed assets.", async () => {
		const seedSymbols = getRealAssetSymbols(MAX_TRACKED_ASSETS + 1);
		const { data: existingAssets, error: existingAssetsError } =
			await adminClient
				.from("assets")
				.select("symbol")
				.in("symbol", seedSymbols);
		expect(existingAssetsError).toBeNull();

		const existingSymbolSet = new Set(
			(existingAssets ?? []).map((row) => row.symbol),
		);
		const symbolsToInsert = seedSymbols.filter(
			(symbol) => !existingSymbolSet.has(symbol),
		);

		const seedRecords = symbolsToInsert.map((symbol) => {
			const assetData = getAssetData(symbol);
			return {
				symbol: assetData.symbol,
				name: assetData.name,
				type: assetData.type,
			};
		});

		if (seedRecords.length > 0) {
			const { error: insertError } = await adminClient
				.from("assets")
				.upsert(seedRecords, { onConflict: "symbol" });
			expect(insertError).toBeNull();
		}

		try {
			const initialAssets = seedSymbols.slice(0, MAX_TRACKED_ASSETS);
			const assetsExceedingLimit = seedSymbols.slice(0, MAX_TRACKED_ASSETS + 1);

			const { response, trackedAssets, payload } = await updateTrackedAssets(
				initialAssets,
				assetsExceedingLimit,
				{},
				registerTestUserForCleanup,
			);

			expect(response.status).toBe(400);
			expect(payload.ok).toBe(false);
			expect(payload.message).toBe("assets_limit");

			expect(trackedAssets).toHaveLength(MAX_TRACKED_ASSETS);
		} finally {
			if (symbolsToInsert.length > 0) {
				const { error: assetDeleteError } = await adminClient
					.from("assets")
					.delete()
					.in("symbol", symbolsToInsert);
				if (assetDeleteError) {
					rootLogger.warn("Cleanup failed (assets)", {
						error: assetDeleteError,
					});
				}
			}
		}
	});

	it("A user with no tracked assets adds their first asset.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			[],
			["AAPL"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(1);
		expect(trackedAssets?.[0]?.symbol).toBe("AAPL");
	});

	it("A user with one tracked asset removes it.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["AAPL"],
			[],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(0);
	});

	it("A user with one tracked asset adds another.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["AAPL"],
			["AAPL", "MSFT"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(2);
		expect(trackedAssets?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("A user replaces their tracked assets with a new set.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["TSLA", "NVDA"],
			["AAPL", "MSFT"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(2);
		expect(trackedAssets?.map((s) => s.symbol)).toEqual(["AAPL", "MSFT"]);
	});

	it("A user clears all tracked assets.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["AAPL", "MSFT", "GOOGL"],
			[],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(0);
	});

	it("A user with no tracked assets adds an ETF.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			[],
			["SPY"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(1);
		expect(trackedAssets?.[0]?.symbol).toBe("SPY");
	});

	it("A user tracks a mix of stocks and ETFs.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			[],
			["AAPL", "SPY", "MSFT", "QQQ"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(4);
		expect(trackedAssets?.map((s) => s.symbol)).toEqual([
			"AAPL",
			"MSFT",
			"QQQ",
			"SPY",
		]);
	});

	it("A user replaces tracked stocks with ETFs.", async () => {
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["AAPL", "MSFT"],
			["VOO", "VTI"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(200);
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("assets_updated");

		expect(trackedAssets).toHaveLength(2);
		expect(trackedAssets?.map((s) => s.symbol)).toEqual(["VOO", "VTI"]);
	});

	it("User submitting duplicate symbols receives validation error.", async () => {
		allowConsoleErrors();
		const { response, trackedAssets, payload } = await updateTrackedAssets(
			["AAPL"],
			["AAPL", "AAPL", "MSFT"],
			{},
			registerTestUserForCleanup,
		);

		expect(response.status).toBe(500);
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("failed_to_update_assets");
		// RPC rolls back on duplicate error — initial assets preserved
		expect(trackedAssets ?? []).toHaveLength(1);
	});

	it("User submitting invalid asset symbol (not in assets table) receives error and assets remain unchanged.", async () => {
		allowConsoleErrors();
		const testUser = await createTestUser({
			email: `assets-invalid-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("tracked_assets", JSON.stringify(["INVALIDX"]));

		const response = await POST({
			request: new Request("http://localhost/api/assets/update", {
				method: "POST",
				body: formData,
			}),
			cookies: {
				get: (name: string) => {
					const value = cookies.get(name);
					return value ? { value } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(500);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("failed_to_update_assets");

		const { data: trackedAssets } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", testUser.id)
			.order("symbol");
		expect(trackedAssets).toHaveLength(1);
		expect(trackedAssets?.[0]?.symbol).toBe("AAPL");
	});
});
