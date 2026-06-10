import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { getAssetData } from "../asset-data";
import { upsertAssets } from "../asset-db";
import { adminClient } from "../test-env";

const NOTIFICATION_PREFERENCES_UPDATE_URL = "/api/notification-preferences/update";

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function waitForAutosave(
	page: Page,
	action: () => Promise<void>,
	timeoutMs = 30_000,
): Promise<void> {
	const responsePromise = page.waitForResponse(
		(response) =>
			response.url().includes(NOTIFICATION_PREFERENCES_UPDATE_URL) && response.status() === 200,
		{ timeout: timeoutMs },
	);
	await action();
	await responsePromise;
}

export async function addAsset(page: Page, symbol: string): Promise<void> {
	const input = page.locator("#asset_search");
	const option = page
		.locator("#asset_dropdown")
		.getByRole("option")
		.filter({ hasText: new RegExp(`${escapeRegExp(symbol)}\\s+-`) });

	await expect(input).toBeVisible({ timeout: 15_000 });
	await page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });
	await input.fill(symbol);
	await expect(option).toBeVisible({ timeout: 30_000 });
	await input.press("ArrowDown");
	await input.press("Enter");
	await expect(page.getByRole("button", { name: `Remove ${symbol}` })).toBeVisible({
		timeout: 15_000,
	});
}

export async function ensureAssetsExist(symbols: string[]): Promise<void> {
	const uniqueSymbols = [...new Set(symbols)];
	const assetRecords = uniqueSymbols.map((symbol) => {
		const assetData = getAssetData(symbol);
		return {
			symbol: assetData.symbol,
			name: assetData.name,
			type: assetData.type,
		};
	});
	await upsertAssets(assetRecords);
}

export async function waitForTrackedAssets(
	userId: string,
	expectedSymbols: string[],
	timeoutMs = 30_000,
): Promise<void> {
	const expected = [...expectedSymbols].sort();
	await expect
		.poll(
			async () => {
				const { data, error } = await adminClient
					.from("user_assets")
					.select("symbol")
					.eq("user_id", userId)
					.order("symbol");
				if (error) {
					throw new Error(`Failed to read tracked assets: ${error.message}`);
				}
				return (data ?? []).map((row) => row.symbol).sort();
			},
			{
				timeout: timeoutMs,
				intervals: [100, 250, 500, 1000],
				message: `Timed out waiting for tracked assets to become [${expected.join(", ")}]`,
			},
		)
		.toEqual(expected);
}

export async function waitForEmailNotificationsEnabled(
	userId: string,
	expectedValue: boolean,
	timeoutMs = 30_000,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const { data, error } = await adminClient
					.from("users")
					.select("email_notifications_enabled")
					.eq("id", userId)
					.single();
				if (error) {
					throw new Error(`Failed to read email notification state: ${error.message}`);
				}
				return data.email_notifications_enabled;
			},
			{
				timeout: timeoutMs,
			},
		)
		.toBe(expectedValue);
}
