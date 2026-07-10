/**
 * Integration tests for single-symbol icon probes (`ensureAssetIconChecked`).
 *
 * Uses real local Supabase + the injectable `getTickerDetail` seam — no network.
 * Asset fixture seeding goes through `upsertAssets` (direct `pg`).
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureAssetIconChecked } from "../../../src/lib/assets/icon-check";
import type { TickerDetail } from "../../../src/lib/assets/types";
import { rootLogger } from "../../../src/lib/logging";
import { deleteAssets, markAllAssetIconsChecked, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";

/**
 * Unique test symbol prefix (max 10 chars, alphanumeric uppercase). `Z` prefix
 * keeps us out of real-ticker space; the random suffix avoids collisions.
 */
const TEST_PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

async function getAsset(symbol: string) {
	const { data } = await adminClient
		.from("assets")
		.select("symbol, icon_url, icon_checked_at, delisted_at")
		.eq("symbol", symbol)
		.maybeSingle();
	return data;
}

function makeFakeDetail(bySymbol?: Map<string, TickerDetail | Error>): {
	fn: (symbol: string) => Promise<TickerDetail>;
	calls: string[];
} {
	const calls: string[] = [];
	const fn = async (symbol: string): Promise<TickerDetail> => {
		calls.push(symbol);
		const detail = bySymbol?.get(symbol);
		if (detail instanceof Error) throw detail;
		return detail ?? { ok: false };
	};
	return { fn, calls };
}

describe("ensureAssetIconChecked", () => {
	const createdSymbols: string[] = [];

	beforeAll(async () => {
		await markAllAssetIconsChecked();
	});

	afterEach(async () => {
		await deleteAssets(createdSymbols).catch(() => {});
		createdSymbols.length = 0;
	});

	it("Probes and stamps a never-checked symbol.", async () => {
		const symbol = `${TEST_PREFIX}ADD1`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "On Add Probe Inc", type: "stock" }]);

		const detail = makeFakeDetail(
			new Map([
				[
					symbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
					},
				],
			]),
		);
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({
			probed: true,
			iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
		});
		expect(detail.calls).toEqual([symbol]);
		const row = await getAsset(symbol);
		expect(row?.icon_url).toBe(result.iconUrl);
		expect(row?.icon_checked_at).not.toBeNull();
	});

	it("No-ops when the symbol was already checked — Massive is not called again.", async () => {
		const symbol = `${TEST_PREFIX}ADD2`;
		createdSymbols.push(symbol);
		const existingUrl = `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`;
		await upsertAssets([
			{
				symbol,
				name: "Already Checked Inc",
				type: "stock",
				icon_url: existingUrl,
				icon_checked_at: "2026-06-15T02:00:00Z",
			},
		]);

		const detail = makeFakeDetail();
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({ probed: false, iconUrl: existingUrl });
		expect(detail.calls).toEqual([]);
	});

	it("Stamps icon_checked_at with a null icon_url on a definitive no-logo answer.", async () => {
		const symbol = `${TEST_PREFIX}NONE`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "No Branding Inc", type: "stock" }]);

		const detail = makeFakeDetail(new Map([[symbol, { ok: true, iconUrl: null }]]));
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({ probed: true, iconUrl: null });
		const row = await getAsset(symbol);
		expect(row?.icon_url).toBeNull();
		expect(row?.icon_checked_at).not.toBeNull();
	});

	it("Leaves the row unchecked on transport failure so a later probe can retry.", async () => {
		const symbol = `${TEST_PREFIX}FAIL`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Transport Fail Inc", type: "stock" }]);

		const detail = makeFakeDetail(new Map([[symbol, { ok: false }]]));
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({ probed: false, iconUrl: null });
		expect((await getAsset(symbol))?.icon_checked_at).toBeNull();
	});

	it("Force-reprobes an already-checked row and clears icon_base64.", async () => {
		const symbol = `${TEST_PREFIX}FORCE`;
		createdSymbols.push(symbol);
		const oldUrl =
			"https://api.massive.com/v1/reference/company-branding/x/images/2024-01-01_icon.png";
		const newUrl =
			"https://api.massive.com/v1/reference/company-branding/x/images/2026-07-01_icon.png";
		await upsertAssets([
			{
				symbol,
				name: "Force Refresh Inc",
				type: "stock",
				icon_url: oldUrl,
				icon_checked_at: "2026-01-01T00:00:00Z",
				icon_base64: "data:image/png;base64,old",
			},
		]);

		const detail = makeFakeDetail(new Map([[symbol, { ok: true, iconUrl: newUrl }]]));
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			force: true,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({ probed: true, iconUrl: newUrl });
		expect(detail.calls).toEqual([symbol]);
		const { data } = await adminClient
			.from("assets")
			.select("icon_url, icon_base64, icon_checked_at")
			.eq("symbol", symbol)
			.maybeSingle();
		expect(data?.icon_url).toBe(newUrl);
		expect(data?.icon_base64).toBeNull();
		expect(data?.icon_checked_at).not.toBe("2026-01-01T00:00:00Z");
	});
});
