import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { DeliveryChannelMode } from "../../../src/lib/constants";
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

export async function waitForDeliveryChannel(
	userId: string,
	expectedValue: DeliveryChannelMode,
	timeoutMs = 30_000,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const { data, error } = await adminClient
					.from("users")
					.select("delivery_channel")
					.eq("id", userId)
					.single();
				if (error) {
					throw new Error(`Failed to read delivery_channel: ${error.message}`);
				}
				return data.delivery_channel;
			},
			{
				timeout: timeoutMs,
			},
		)
		.toBe(expectedValue);
}

/** Select a delivery-channel radio in the Notifications panel. */
export async function selectDeliveryChannel(
	page: Page,
	channel: "Email" | "Telegram" | "Disabled",
): Promise<void> {
	const valueByLabel = {
		Email: "email",
		Telegram: "telegram",
		Disabled: "disabled",
	} as const;
	const value = valueByLabel[channel];
	const radio = page.locator(`input[name="delivery_channel_radio"][value="${value}"]`);
	await expect(radio).toBeVisible({ timeout: 15_000 });
	await radio.scrollIntoViewIfNeeded();
	if (await radio.isChecked()) {
		return;
	}
	await waitForAutosave(page, async () => {
		// Vue binds :checked on these sr-only radios under a full-size label.
		// Playwright click/check fights that binding (and the Astro toolbar);
		// dispatch change so the @change → selectChannel → notifyChange path runs.
		await radio.evaluate((el) => {
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
	});
}
