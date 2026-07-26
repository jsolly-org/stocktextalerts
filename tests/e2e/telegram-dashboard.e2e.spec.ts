import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../../src/lib/constants";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { signIn } from "../helpers/e2e/auth";
import { openChannelMultiselect, waitForAutosave } from "../helpers/e2e/dashboard";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser, setTestUserPrefs } from "../helpers/test-user";

// Screenshot targets under the repo-local Playwright artifact dir so local agents
// and CI can both read them off disk after the run.
const SCREENSHOT_DIR = path.join(process.cwd(), ".playwright-mcp/cli/telegram-dashboard-ui");
mkdirSync(SCREENSHOT_DIR, { recursive: true });
const SCREENSHOT_CONNECT = path.join(SCREENSHOT_DIR, "_ui-connect.png");
const SCREENSHOT_PANEL = path.join(SCREENSHOT_DIR, "_ui-panel.png");
const SCREENSHOT_DROPDOWN = path.join(SCREENSHOT_DIR, "_ui-dropdown.png");

// A linked Telegram chat id (set by the bot /start webhook in production). Its
// presence shows the Connected pill on the Telegram Notifications toggle row
// (and hides the connect card) and enables the Telegram option in every channel
// multiselect.
const TELEGRAM_CHAT_ID = 8675309;

/**
 * Read a single Telegram notification-preference row's `enabled` flag.
 *
 * daily_digest / asset_events rows carry a content facet ("prices", "calendar", …);
 * the facet-less market types use content='' (the default arg).
 */
async function getTelegramPreference(
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
		.eq("channel", "telegram")
		.maybeSingle();
	if (error) {
		throw new Error(
			`Failed to read telegram preference (${notificationType}/${content}): ${error.message}`,
		);
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

		// Email-enabled + tracked asset so the daily-digest panel isn't blocked by
		// the "needs a channel / needs tracked assets" setup notice (which would
		// disable every multiselect, Telegram included).
		const user = await createTestUser({
			confirmed: true,
			approved: true,
			emailNotificationsEnabled: true,
			trackedAssets: ["AAPL"],
		});
		userId = user.id;
		email = user.email;

		// Link Telegram: chat id + linked timestamp ⇒ Connected pill on the
		// Telegram Notifications row; connect card hidden; channel option selectable.
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

		// Pre-select Telegram for the daily-digest "prices" option so the panel
		// renders one multiselect with Telegram already chosen (server reads this
		// row into the panel's `telegramPrefs` prop). Upsert because createTestUser
		// already seeds the (default-off) prices/telegram row.
		await setTestUserPrefs(userId, [["daily_notification", "prices", "telegram", true]]);

		await signIn(page, email, TEST_PASSWORD);
	});

	test.afterAll(async () => {
		if (userId) {
			try {
				// notification_preferences rows are FK'd to users with ON DELETE CASCADE,
				// so deleting the user row clears the seeded telegram preference too.
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

	test("renders Connected pill + channel multiselects, captures screenshots, persists a Telegram toggle", async () => {
		await page.goto("/dashboard");

		// --- Telegram channel (linked) ----------------------------------------
		// Connected accounts hide the connect card and show the global toggle
		// with a Connected pill next to the label.
		const telegramToggleLabel = page.getByText("Telegram Notifications", { exact: true });
		await expect(telegramToggleLabel).toBeVisible();
		const telegramToggleRow = telegramToggleLabel.locator(
			"xpath=ancestor::div[contains(@class, 'justify-between')][1]",
		);
		await expect(telegramToggleRow.getByText("Connected", { exact: true })).toBeVisible();
		await telegramToggleRow.scrollIntoViewIfNeeded();
		await telegramToggleRow.screenshot({ path: SCREENSHOT_CONNECT });
		await expect(page.getByRole("heading", { name: "Telegram", exact: true })).toHaveCount(0);

		// --- Daily Notification panel (multiselect triggers) -------------------
		const digestForm = page.locator('form[aria-label="Daily Notification"]');
		await expect(digestForm).toBeVisible();

		const pricesTrigger = page.locator("#daily_digest_include_prices-channel-trigger");
		const topMoversTrigger = page.locator("#daily_digest_include_top_movers-channel-trigger");
		await expect(pricesTrigger).toBeVisible();
		await expect(topMoversTrigger).toBeVisible();

		// The seeded prices/telegram row must surface in the trigger summary text.
		await expect(pricesTrigger).toHaveAttribute("aria-haspopup", "listbox");
		await expect(pricesTrigger).toContainText("Telegram");

		await digestForm.scrollIntoViewIfNeeded();
		await digestForm.screenshot({ path: SCREENSHOT_PANEL });

		// --- Open one multiselect and screenshot the open listbox --------------
		const topMoversListbox = await openChannelMultiselect(page, "daily_digest_include_top_movers");
		await expect(topMoversListbox).toHaveAttribute("role", "listbox");
		// Both channels render for prices/top_movers (Email, Telegram).
		const telegramOption = topMoversListbox.getByRole("option", { name: "Telegram" });
		await expect(telegramOption).toBeVisible();
		await expect(topMoversListbox.getByRole("option", { name: "Email" })).toBeVisible();
		await page.screenshot({ path: SCREENSHOT_DROPDOWN });

		// --- Behavior: toggling Telegram on for Top Movers flips the DB row ---
		// Precondition: top_movers/telegram is seeded off by default (the full
		// preference catalog is seeded for every user).
		expect(await getTelegramPreference(userId as string, "daily_notification", "top_movers")).toBe(
			false,
		);

		await waitForAutosave(page, async () => {
			await telegramOption.click();
		});

		// The new row persisted as enabled.
		expect(await getTelegramPreference(userId as string, "daily_notification", "top_movers")).toBe(
			true,
		);
		// The pre-seeded prices/telegram row is untouched (still enabled).
		expect(await getTelegramPreference(userId as string, "daily_notification", "prices")).toBe(
			true,
		);

		// The trigger summary now reflects the new Telegram selection in the UI.
		await expect(topMoversTrigger).toContainText("Telegram");
		await page.keyboard.press("Escape");
		await expect(topMoversListbox).toBeHidden();
	});

	test("global Telegram notifications toggle mutes delivery without unlinking", async () => {
		await page.goto("/dashboard");
		await page
			.locator('form[aria-label="Notification preferences"][data-hydrated]')
			.waitFor({ timeout: 15_000 });

		const telegramSwitch = page.getByRole("switch", { name: "Telegram notifications" });
		await expect(telegramSwitch).toBeVisible();
		await expect(telegramSwitch).toHaveAttribute("aria-checked", "true");

		await waitForAutosave(page, async () => {
			await telegramSwitch.click();
		});

		const { data: muted } = await adminClient
			.from("users")
			.select("telegram_opted_out,telegram_chat_id")
			.eq("id", userId as string)
			.single();
		expect(muted?.telegram_opted_out).toBe(true);
		expect(muted?.telegram_chat_id).toBe(TELEGRAM_CHAT_ID);
		await expect(telegramSwitch).toHaveAttribute("aria-checked", "false");

		// Per-option Telegram channels become disabled while globally muted.
		const topMoversListbox = await openChannelMultiselect(page, "daily_digest_include_top_movers");
		const telegramOption = topMoversListbox.getByRole("option", { name: "Telegram" });
		await expect(telegramOption).toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");

		await waitForAutosave(page, async () => {
			await telegramSwitch.click();
		});

		const { data: unmuted } = await adminClient
			.from("users")
			.select("telegram_opted_out")
			.eq("id", userId as string)
			.single();
		expect(unmuted?.telegram_opted_out).toBe(false);
		await expect(telegramSwitch).toHaveAttribute("aria-checked", "true");

		const unmutedListbox = await openChannelMultiselect(page, "daily_digest_include_top_movers");
		await expect(unmutedListbox.getByRole("option", { name: "Telegram" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await page.keyboard.press("Escape");
	});

	test("toggling Telegram on a Market panel option and a daily asset-event option each persist a DB row", async () => {
		await page.goto("/dashboard", { waitUntil: "networkidle" });
		await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

		// --- Market Notifications: Price Move Alerts (content='') --------------
		// This facet-less market type keys its telegram pref by notification_type.
		const marketForm = page.locator('form[aria-label="Market notifications"]');
		await marketForm.scrollIntoViewIfNeeded();
		const priceMoveTrigger = page.locator("#price_move_alerts-channel-trigger");
		await expect(priceMoveTrigger).toBeVisible();
		await expect(priceMoveTrigger).toHaveAttribute("aria-haspopup", "listbox");

		const priceMoveListbox = await openChannelMultiselect(page, "price_move_alerts");
		const priceMoveTelegram = priceMoveListbox.getByRole("option", { name: "Telegram" });
		await expect(priceMoveTelegram).toBeVisible();

		// Precondition: price_move_alerts/telegram is seeded off by default.
		expect(await getTelegramPreference(userId as string, "price_move_alerts")).toBe(false);

		await waitForAutosave(page, async () => {
			await priceMoveTelegram.click();
		});

		// The new row persisted as enabled (content='' for this market type).
		expect(await getTelegramPreference(userId as string, "price_move_alerts")).toBe(true);
		await expect(priceMoveTrigger).toContainText("Telegram");

		// --- Daily notification: Calendar asset event (content='calendar') --------
		const dailyForm = page.locator('form[aria-label="Daily Notification"]');
		await dailyForm.scrollIntoViewIfNeeded();
		const calendarTrigger = page.locator("#asset_events_calendar-channel-trigger");
		await expect(calendarTrigger).toBeVisible();

		const calendarListbox = await openChannelMultiselect(page, "asset_events_calendar");
		const calendarTelegram = calendarListbox.getByRole("option", { name: "Telegram" });
		await expect(calendarTelegram).toBeVisible();

		// Precondition: daily_notification/calendar/telegram is seeded off by default.
		expect(await getTelegramPreference(userId as string, "daily_notification", "calendar")).toBe(
			false,
		);

		await waitForAutosave(page, async () => {
			await calendarTelegram.click();
		});

		// The new row persisted as enabled, keyed by the calendar content facet.
		expect(await getTelegramPreference(userId as string, "daily_notification", "calendar")).toBe(
			true,
		);
		await expect(calendarTrigger).toContainText("Telegram");
	});

	test("dashboard exposes a form control for every catalog option and no stale ones (drift check)", async () => {
		await page.goto("/dashboard", { waitUntil: "networkidle" });
		await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

		// Every option in NOTIFICATION_OPTION_MATRIX must be editable on the
		// dashboard: a missing control means the catalog gained an option the UI
		// never renders (add the control + its copy to the matching panel).
		const renderedNames = new Set<string | null>(
			await page
				.locator('[name*="_include_"]')
				.evaluateAll((els) => els.map((el) => el.getAttribute("name"))),
		);
		const expectedNames = new Set<string>(NOTIFICATION_PREFERENCE_CATALOG.map((e) => e.fieldName));
		const missing = [...expectedNames].filter((n) => !renderedNames.has(n));
		const stale = [...renderedNames].filter((n) => n !== null && !expectedNames.has(n));
		expect(missing, "catalog options with no dashboard control").toEqual([]);
		expect(stale, "dashboard controls for options no longer in the catalog").toEqual([]);
	});
});

test.describe("Telegram-only notification channel (email global off)", () => {
	test("does not show the 'enable a channel' warning when Telegram is linked", async ({
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
				// Reproduce the bug: global email off, Telegram linked + usable.
				emailNotificationsEnabled: false,
				trackedAssets: ["AAPL"],
			});
			userId = user.id;

			const { error: linkError } = await adminClient
				.from("users")
				.update({
					telegram_chat_id: TELEGRAM_CHAT_ID,
					telegram_linked_at: new Date().toISOString(),
					telegram_opted_out: false,
				})
				.eq("id", userId);
			if (linkError) {
				throw new Error(`Failed to link telegram chat id: ${linkError.message}`);
			}

			await signIn(page, user.email, TEST_PASSWORD);
			await page.goto("/dashboard", { waitUntil: "networkidle" });
			await page.locator("[data-hydrated]").first().waitFor({ state: "attached", timeout: 15_000 });

			const channelWarning = page.getByText("Enable at least one notification channel", {
				exact: false,
			});
			await expect(channelWarning).toHaveCount(0);

			// Telegram must remain selectable — the setup notice used to opacity-block
			// the whole daily panel when only email was considered a channel.
			const digestForm = page.locator('form[aria-label="Daily Notification"]');
			await expect(digestForm).toBeVisible();
			await expect(digestForm.locator("fieldset").first()).not.toHaveAttribute(
				"aria-disabled",
				"true",
			);

			const pricesListbox = await openChannelMultiselect(page, "daily_digest_include_prices");
			const telegramOption = pricesListbox.getByRole("option", { name: "Telegram" });
			await expect(telegramOption).toBeVisible();
			await expect(telegramOption).not.toHaveAttribute("aria-disabled", "true");

			const emailOption = pricesListbox.getByRole("option", { name: "Email" });
			await expect(emailOption).toHaveAttribute("aria-disabled", "true");
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
