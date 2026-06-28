import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { signIn } from "../helpers/e2e/auth";
import { waitForAutosave } from "../helpers/e2e/dashboard";
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
// presence flips the Connect card to "Connected" and enables the Telegram option
// in every channel multiselect.
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

		// Link Telegram: chat id + linked timestamp ⇒ Connect card shows "Connected"
		// and the Telegram channel option becomes selectable.
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
		await setTestUserPrefs(userId, [["daily_digest", "prices", "telegram", true]]);

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

	test("renders Connect card + channel multiselects, captures screenshots, persists a Telegram toggle", async () => {
		await page.goto("/dashboard");

		// --- Connect Telegram card ---------------------------------------------
		// The card root is the nearest `rounded-lg border` div ancestor of the
		// <h3>Telegram</h3> heading. That root also holds the "Connected" pill,
		// which a tighter ancestor (the inner min-w-0 div) would exclude.
		const connectHeading = page.getByRole("heading", { name: "Telegram", exact: true });
		await expect(connectHeading).toBeVisible();
		const connectCard = connectHeading.locator(
			"xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-lg ')][1]",
		);
		// Linked state shows the "Connected" pill + the linked-account copy.
		await expect(connectCard.getByText("Connected", { exact: true })).toBeVisible();
		await connectCard.scrollIntoViewIfNeeded();
		await connectCard.screenshot({ path: SCREENSHOT_CONNECT });

		// --- Daily Digest panel (multiselect triggers) -------------------------
		const digestForm = page.locator('form[aria-label="Daily Digest"]');
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
		await topMoversTrigger.click();
		const topMoversListbox = page.locator("#daily_digest_include_top_movers-channel-listbox");
		await expect(topMoversListbox).toBeVisible();
		await expect(topMoversListbox).toHaveAttribute("role", "listbox");
		// All three channels render for prices/top_movers (Email, SMS, Telegram).
		const telegramOption = topMoversListbox.getByRole("option", { name: "Telegram" });
		await expect(telegramOption).toBeVisible();
		await expect(topMoversListbox.getByRole("option", { name: "Email" })).toBeVisible();
		await expect(topMoversListbox.getByRole("option", { name: "SMS" })).toBeVisible();
		await page.screenshot({ path: SCREENSHOT_DROPDOWN });

		// --- Behavior: toggling Telegram on for Top Movers flips the DB row ---
		// Precondition: top_movers/telegram is seeded off by default (the full
		// preference catalog is seeded for every user).
		expect(await getTelegramPreference(userId as string, "daily_digest", "top_movers")).toBe(false);

		await waitForAutosave(page, async () => {
			await telegramOption.click();
		});

		// The new row persisted as enabled.
		expect(await getTelegramPreference(userId as string, "daily_digest", "top_movers")).toBe(true);
		// The pre-seeded prices/telegram row is untouched (still enabled).
		expect(await getTelegramPreference(userId as string, "daily_digest", "prices")).toBe(true);

		// The trigger summary now reflects the new Telegram selection in the UI.
		await expect(topMoversTrigger).toContainText("Telegram");
	});

	test("toggling Telegram on a Market panel option and an Asset Events option each persist a DB row", async () => {
		await page.goto("/dashboard");

		// --- Market Notifications: 5% Price Move Alerts (content='') -----------
		// This facet-less market type keys its telegram pref by notification_type.
		const priceMoveTrigger = page.locator("#price_move_alerts-channel-trigger");
		await expect(priceMoveTrigger).toBeVisible();
		await expect(priceMoveTrigger).toHaveAttribute("aria-haspopup", "listbox");
		await priceMoveTrigger.scrollIntoViewIfNeeded();

		await priceMoveTrigger.click();
		const priceMoveListbox = page.locator("#price_move_alerts-channel-listbox");
		await expect(priceMoveListbox).toBeVisible();
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

		// --- Asset Events: Calendar (content='calendar') -----------------------
		const calendarTrigger = page.locator("#asset_events_calendar-channel-trigger");
		await expect(calendarTrigger).toBeVisible();
		await calendarTrigger.scrollIntoViewIfNeeded();

		await calendarTrigger.click();
		const calendarListbox = page.locator("#asset_events_calendar-channel-listbox");
		await expect(calendarListbox).toBeVisible();
		const calendarTelegram = calendarListbox.getByRole("option", { name: "Telegram" });
		await expect(calendarTelegram).toBeVisible();

		// Precondition: asset_events/calendar/telegram is seeded off by default.
		expect(await getTelegramPreference(userId as string, "asset_events", "calendar")).toBe(false);

		await waitForAutosave(page, async () => {
			await calendarTelegram.click();
		});

		// The new row persisted as enabled, keyed by the calendar content facet.
		expect(await getTelegramPreference(userId as string, "asset_events", "calendar")).toBe(true);
		await expect(calendarTrigger).toContainText("Telegram");
	});
});
