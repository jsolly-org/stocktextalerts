import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

// Chicago user: market window = 9:00 AM – 2:59 PM CT = 540–899 minutes.
// Afterward, auto-add steps at 60-min increments (shrinking near close), so
// packing 8 slots reaches 14:56 CT (896 minutes) and never exceeds 899.
const CHICAGO_LOWER_MINUTES = 540;
const CHICAGO_UPPER_MINUTES = 899;
const CHICAGO_AFTER_OPEN_MINUTES = 540; // 10:00 AM ET = 9:00 AM CT
const MAX_DELIVERY_TIMES = 8;
const OUTSIDE_HOURS_TOOLTIP = "Outside US market hours (10:00 AM – 3:59 PM ET)";
const UPDATE_URL_MATCH = "/api/notification-preferences/update";

async function signIn(page: Page, email: string, password: string) {
	await page.goto("/auth/signin");
	const emailInput = page.locator("#email");
	await expect
		.poll(
			async () => {
				await emailInput.fill(email);
				return emailInput.inputValue();
			},
			{ timeout: 10_000, message: "Email value cleared by hydration" },
		)
		.toBe(email);
	await page.locator("#password").fill(password);
	await page.getByRole("button", { name: "Sign In" }).click();
	await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

async function waitForAutosave(
	page: Page,
	action: () => Promise<void>,
): Promise<void> {
	const responsePromise = page.waitForResponse(
		(response) =>
			response.url().includes(UPDATE_URL_MATCH) && response.status() === 200,
		{ timeout: 15_000 },
	);
	await action();
	await responsePromise;
}

async function getScheduledTimes(userId: string): Promise<number[] | null> {
	const { data, error } = await adminClient
		.from("users")
		.select("market_scheduled_asset_price_times")
		.eq("id", userId)
		.single();
	if (error) {
		throw new Error(`Failed to read scheduled times: ${error.message}`);
	}
	return data.market_scheduled_asset_price_times;
}

async function getDailyDigestTime(userId: string): Promise<number | null> {
	const { data, error } = await adminClient
		.from("users")
		.select("daily_digest_time")
		.eq("id", userId)
		.single();
	if (error) {
		throw new Error(`Failed to read daily digest time: ${error.message}`);
	}
	return data.daily_digest_time;
}

test.describe("delivery times and timepicker", () => {
	test.describe.configure({ mode: "serial" });

	let context: BrowserContext;
	let page: Page;
	let userId: string | null = null;
	let email = "";

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();

		const user = await createTestUser({
			confirmed: true,
			emailNotificationsEnabled: true,
			marketScheduledAssetPriceIncludeEmail: true,
			timezone: "America/Chicago",
			// Explicit empty array → createTestUser normalizes to null (no times seeded).
			scheduledUpdateTimes: [],
			trackedAssets: ["AAPL"],
		});
		userId = user.id;
		email = user.email;

		await signIn(page, email, TEST_PASSWORD);
	});

	test.afterAll(async () => {
		if (userId) {
			try {
				await cleanupTestUser(userId);
			} catch (error) {
				rootLogger.warn("Failed to cleanup delivery-times test user", {
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

	test("n=0: empty state renders initial picker only, no Add time button", async () => {
		await page.goto("/dashboard");
		const form = page.locator('form[aria-label="Market notifications"]');
		await expect(form).toBeVisible();

		// Empty state: just the initial picker + After open shortcut.
		await expect(form.locator("#scheduled_update_time_initial")).toBeVisible();
		await expect(form.locator("#scheduled_update_time_0")).toHaveCount(0);
		await expect(form.getByRole("button", { name: "Add time" })).toHaveCount(0);
		await expect(
			form.getByRole("button", {
				name: /Set delivery time to after US market open/i,
			}),
		).toBeVisible();

		// DB confirms no times seeded.
		expect(await getScheduledTimes(userId as string)).toBeNull();
	});

	test("disabled overlay: cells outside market window get title + not-allowed cursor", async () => {
		const form = page.locator('form[aria-label="Market notifications"]');
		await form.locator("#scheduled_update_time_initial").click();

		const menu = page.locator(".dp__menu");
		await expect(menu).toBeVisible();

		// Open the hour overlay grid. Fresh picker defaults to 9:00 AM (the
		// TimePicker timeConfig.startTime), so the grid renders in AM mode:
		// 09/10/11 valid; 12 & 01–08 disabled.
		await menu.locator('[data-test-id="hours-toggle-overlay-btn-0"]').click();

		// vue-datepicker renders each hour as a <div role="gridcell"> with a
		// nested <div> that carries the dp__overlay_cell* classes + our injected
		// title attribute. Targeting the parent gridcell first lets us assert
		// aria-disabled, then drilling into the inner div checks the visual
		// affordances.
		const twelveCell = menu.locator('[role="gridcell"][data-test-id="12"]');
		await expect(twelveCell).toHaveAttribute("aria-disabled", "true");
		const twelveInner = twelveCell.locator(".dp__overlay_cell_disabled");
		await expect(twelveInner).toHaveAttribute("title", OUTSIDE_HOURS_TOOLTIP);
		const disabledCursor = await twelveInner.evaluate(
			(el) => window.getComputedStyle(el).cursor,
		);
		expect(disabledCursor).toBe("not-allowed");

		const nineCell = menu.locator('[role="gridcell"][data-test-id="09"]');
		expect(await nineCell.getAttribute("aria-disabled")).toBeNull();

		// Close the menu without committing so the next test starts clean.
		await menu.getByRole("button", { name: "Cancel" }).click();
		await expect(menu).toBeHidden();
	});

	test("n=0 → n=1: 'After open' seeds the first delivery time", async () => {
		const form = page.locator('form[aria-label="Market notifications"]');
		await waitForAutosave(page, async () => {
			await form
				.getByRole("button", {
					name: /Set delivery time to after US market open/i,
				})
				.click();
		});

		await expect(form.locator("#scheduled_update_time_0")).toBeVisible();
		await expect(form.getByRole("button", { name: "Add time" })).toBeVisible();

		const times = await getScheduledTimes(userId as string);
		expect(times).toEqual([CHICAGO_AFTER_OPEN_MINUTES]);
	});

	test("n=1 → n=many: 'Add time' packs market hours until max reached", async () => {
		const form = page.locator('form[aria-label="Market notifications"]');
		const addTimeButton = form.getByRole("button", { name: "Add time" });

		for (let index = 1; index < MAX_DELIVERY_TIMES; index += 1) {
			await waitForAutosave(page, async () => {
				await addTimeButton.click();
			});
			await expect(
				form.locator(`#scheduled_update_time_${index}`),
			).toBeVisible();
		}

		await expect(addTimeButton).toBeDisabled();
		await expect(
			form.getByText("You've reached the maximum of 8 delivery times."),
		).toBeVisible();

		const times = await getScheduledTimes(userId as string);
		expect(times).toHaveLength(MAX_DELIVERY_TIMES);
		const slots = times as number[];
		for (const value of slots) {
			expect(value).toBeGreaterThanOrEqual(CHICAGO_LOWER_MINUTES);
			expect(value).toBeLessThanOrEqual(CHICAGO_UPPER_MINUTES);
		}
		// Auto-packed slots must be strictly increasing (normalized + deduped).
		for (let i = 1; i < slots.length; i += 1) {
			expect(slots[i]).toBeGreaterThan(slots[i - 1]);
		}
	});

	test("n=8 → n=7: removing a middle slot re-enables Add time", async () => {
		const form = page.locator('form[aria-label="Market notifications"]');
		const before = (await getScheduledTimes(userId as string)) ?? [];
		const removedValue = before[3];

		await waitForAutosave(page, async () => {
			await form
				.getByRole("button", { name: "Remove delivery time 4" })
				.click();
		});

		// 8th row is gone; rows re-index to [0..6].
		await expect(form.locator("#scheduled_update_time_7")).toHaveCount(0);
		await expect(form.locator("#scheduled_update_time_6")).toBeVisible();

		const after = await getScheduledTimes(userId as string);
		expect(after).toHaveLength(MAX_DELIVERY_TIMES - 1);
		expect(after).not.toContain(removedValue);

		await expect(form.getByRole("button", { name: "Add time" })).toBeEnabled();
	});

	test("daily digest picker: any hour allowed, pick persists to DB", async () => {
		// The daily-digest TimePicker is unconstrained — no market-hour window.
		const input = page.locator("#daily_digest_time");
		await input.scrollIntoViewIfNeeded();
		await input.click();

		const menu = page.locator(".dp__menu");
		await expect(menu).toBeVisible();
		await menu.locator('[data-test-id="hours-toggle-overlay-btn-0"]').click();

		// No constraints → no disabled cells in the hour grid.
		await expect(menu.locator(".dp__overlay_cell_disabled")).toHaveCount(0);

		// Pick 10 (AM, since the picker defaults to 09:00 AM via timeConfig.startTime).
		await menu.locator('[role="gridcell"][data-test-id="10"]').click();

		await waitForAutosave(page, async () => {
			await menu.getByRole("button", { name: "Select" }).click();
		});

		expect(await getDailyDigestTime(userId as string)).toBe(600);
	});
});
