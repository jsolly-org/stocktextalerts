import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../../src/lib/constants";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { signIn } from "../helpers/e2e/auth";
import {
	selectDeliveryChannel,
	waitForAutosave,
	waitForDeliveryChannel,
} from "../helpers/e2e/dashboard";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser, setTestUserPrefs } from "../helpers/test-user";

// Screenshot targets under the repo-local Playwright artifact dir so local agents
// and CI can both read them off disk after the run.
const SCREENSHOT_DIR = path.join(process.cwd(), ".playwright-mcp/cli/telegram-dashboard-ui");
mkdirSync(SCREENSHOT_DIR, { recursive: true });
const SCREENSHOT_CONNECT = path.join(SCREENSHOT_DIR, "_ui-connect.png");
const SCREENSHOT_PANEL = path.join(SCREENSHOT_DIR, "_ui-panel.png");
const SCREENSHOT_CHANNELS = path.join(SCREENSHOT_DIR, "_ui-channels.png");

// A linked Telegram chat id (set by the bot /start webhook in production). Its
// presence shows the Connected pill and enables the Telegram delivery option.
const TELEGRAM_CHAT_ID = 8675309;

/**
 * Read a single notification-preference row's `enabled` flag.
 *
 * daily_digest / asset_events rows carry a content facet ("prices", "calendar", …);
 * the facet-less market types use content='' (the default arg).
 */
async function getPreference(
	userId: string,
	notificationType: string,
	content = "",
): Promise<boolean | null> {
	const { data, error } = await adminClient
		.from("notification_preferences")
		.select("enabled")
		.eq("user_id", userId)
		.eq("notification_type", notificationType)
		.eq("content", content)
		.maybeSingle();
	if (error) {
		throw new Error(`Failed to read preference (${notificationType}/${content}): ${error.message}`);
	}
	return data?.enabled ?? null;
}

test.describe("Telegram dashboard UI", () => {
	test.describe.configure({ mode: "serial" });

	let context: BrowserContext;
	let page: Page;
	let userId: string | null = null;
	let email = "";

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();

		// Warm the Vite dev server (cold-start route compile races the first
		// navigation otherwise — see delivery-times.e2e.spec.ts).
		await page.goto("/", { waitUntil: "networkidle" });

		const user = await createTestUser({
			confirmed: true,
			approved: true,
			deliveryChannel: "email",
			trackedAssets: ["AAPL"],
		});
		userId = user.id;
		email = user.email;

		// Link Telegram: chat id + linked timestamp ⇒ Connected pill; Telegram
		// radio becomes selectable.
		const { error: linkError } = await adminClient
			.from("users")
			.update({
				telegram_chat_id: TELEGRAM_CHAT_ID,
				telegram_linked_at: new Date().toISOString(),
			})
			.eq("id", userId);
		if (linkError) {
			throw new Error(`Failed to link telegram chat id: ${linkError.message}`);
		}

		await setTestUserPrefs(userId, [["daily_notification", "prices", true]]);

		await signIn(page, email, TEST_PASSWORD);
	});

	test.afterAll(async () => {
		if (userId) {
			try {
				await cleanupTestUser(userId);
			} catch (error) {
				rootLogger.warn("Failed to cleanup telegram-dashboard test user", {
					context: { error },
				});
			}
		}
		if (page) {
			await page.close();
		}
		if (context) {
			await context.close();
		}
	});

	test("renders Connected pill + delivery radios, captures screenshots, persists a content toggle", async () => {
		await page.goto("/dashboard");
		await page
			.locator('form[aria-label="Notification preferences"][data-hydrated]')
			.waitFor({ timeout: 15_000 });

		// --- Notification Channels (linked Telegram) ---------------------------
		await expect(page.getByText("Telegram connected", { exact: true })).toBeVisible();
		const telegramRadio = page.getByRole("radio", { name: "Telegram" });
		await expect(telegramRadio).toBeVisible();
		await expect(telegramRadio).toBeEnabled();
		await telegramRadio.scrollIntoViewIfNeeded();
		await page
			.locator("[data-notification-channels-card]")
			.screenshot({ path: SCREENSHOT_CONNECT });

		const channelGroup = page.getByRole("radiogroup");
		await channelGroup.screenshot({ path: SCREENSHOT_CHANNELS });

		// --- Daily Notification panel (content toggles) ------------------------
		const digestForm = page.locator('form[aria-label="Daily Notification"]');
		await expect(digestForm).toBeVisible();

		const topMoversSwitch = page.getByRole("switch", { name: /Top Movers/i });
		await expect(topMoversSwitch).toBeVisible();
		await digestForm.scrollIntoViewIfNeeded();
		await digestForm.screenshot({ path: SCREENSHOT_PANEL });

		expect(await getPreference(userId as string, "daily_notification", "top_movers")).toBe(false);

		await waitForAutosave(page, async () => {
			await topMoversSwitch.click();
		});

		expect(await getPreference(userId as string, "daily_notification", "top_movers")).toBe(true);
		expect(await getPreference(userId as string, "daily_notification", "prices")).toBe(true);
	});

	test("delivery_channel radio mutes Telegram without unlinking", async () => {
		await page.goto("/dashboard");
		await page
			.locator('form[aria-label="Notification preferences"][data-hydrated]')
			.waitFor({ timeout: 15_000 });

		const telegramRadio = page.getByRole("radio", { name: "Telegram" });
		await expect(telegramRadio).toBeVisible();

		// Route to Telegram first so Disabled is a real mute from telegram.
		await selectDeliveryChannel(page, "Telegram");
		await waitForDeliveryChannel(userId as string, "telegram");
		await expect(telegramRadio).toHaveAttribute("aria-checked", "true");

		await selectDeliveryChannel(page, "Disabled");
		await waitForDeliveryChannel(userId as string, "disabled");

		const { data: muted } = await adminClient
			.from("users")
			.select("delivery_channel,telegram_chat_id")
			.eq("id", userId as string)
			.single();
		expect(muted?.delivery_channel).toBe("disabled");
		expect(muted?.telegram_chat_id).toBe(TELEGRAM_CHAT_ID);

		await selectDeliveryChannel(page, "Telegram");
		await waitForDeliveryChannel(userId as string, "telegram");
		await expect(telegramRadio).toHaveAttribute("aria-checked", "true");
	});

	test("toggling Market and asset-event content options each persist a DB row", async () => {
		await page.goto("/dashboard", { waitUntil: "networkidle" });
		await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

		const marketForm = page.locator('form[aria-label="Market notifications"]');
		await marketForm.scrollIntoViewIfNeeded();
		const priceMoveSwitch = page.getByRole("switch", { name: /Price Move Alerts/i });
		await expect(priceMoveSwitch).toBeVisible();

		expect(await getPreference(userId as string, "price_move_alerts")).toBe(false);

		await waitForAutosave(page, async () => {
			await priceMoveSwitch.click();
		});

		expect(await getPreference(userId as string, "price_move_alerts")).toBe(true);

		const dailyForm = page.locator('form[aria-label="Daily Notification"]');
		await dailyForm.scrollIntoViewIfNeeded();
		const calendarSwitch = page.getByRole("switch", { name: /Calendar Events/i });
		await expect(calendarSwitch).toBeVisible();

		expect(await getPreference(userId as string, "daily_notification", "calendar")).toBe(false);

		await waitForAutosave(page, async () => {
			await calendarSwitch.click();
		});

		expect(await getPreference(userId as string, "daily_notification", "calendar")).toBe(true);
	});

	test("dashboard exposes a form control for every catalog option and no stale ones (drift check)", async () => {
		await page.goto("/dashboard", { waitUntil: "networkidle" });
		await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

		const renderedNames = new Set<string | null>(
			await page
				.locator('[name*="_include"]')
				.evaluateAll((els) => els.map((el) => el.getAttribute("name"))),
		);
		const expectedNames = new Set<string>(NOTIFICATION_PREFERENCE_CATALOG.map((e) => e.fieldName));
		const missing = [...expectedNames].filter((n) => !renderedNames.has(n));
		const stale = [...renderedNames].filter((n) => n !== null && !expectedNames.has(n));
		expect(missing, "catalog options with no dashboard control").toEqual([]);
		expect(stale, "dashboard controls for options no longer in the catalog").toEqual([]);
	});
});

test.describe("Telegram-only notification channel", () => {
	test("does not show the 'enable a channel' warning when Telegram is the delivery channel", async ({
		browser,
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext();
		const page = await context.newPage();
		let userId: string | null = null;

		try {
			await page.goto("/", { waitUntil: "networkidle" });

			const user = await createTestUser({
				confirmed: true,
				approved: true,
				deliveryChannel: "telegram",
				trackedAssets: ["AAPL"],
			});
			userId = user.id;

			const { error: linkError } = await adminClient
				.from("users")
				.update({
					telegram_chat_id: TELEGRAM_CHAT_ID,
					telegram_linked_at: new Date().toISOString(),
				})
				.eq("id", userId);
			if (linkError) {
				throw new Error(`Failed to link telegram chat id: ${linkError.message}`);
			}

			await signIn(page, user.email, TEST_PASSWORD);
			await page.goto("/dashboard", { waitUntil: "networkidle" });
			await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

			const channelWarning = page.getByText("Choose a delivery method", {
				exact: false,
			});
			await expect(channelWarning).toHaveCount(0);

			const digestForm = page.locator('form[aria-label="Daily Notification"]');
			await expect(digestForm).toBeVisible();
			await expect(digestForm.locator("fieldset").first()).not.toHaveAttribute(
				"aria-disabled",
				"true",
			);

			await expect(page.getByRole("radio", { name: "Telegram" })).toHaveAttribute(
				"aria-checked",
				"true",
			);
		} finally {
			if (userId) {
				try {
					await cleanupTestUser(userId);
				} catch (error) {
					rootLogger.warn("Failed to cleanup telegram-only channel test user", {
						context: { error },
					});
				}
			}
			await page.close();
			await context.close();
		}
	});
});
