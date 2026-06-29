import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectCurrentPath, signIn } from "../helpers/e2e/auth";
import {
	addAsset,
	ensureAssetsExist,
	escapeRegExp,
	waitForAutosave,
	waitForEmailNotificationsEnabled,
	waitForTrackedAssets,
} from "../helpers/e2e/dashboard";
import { createApprovedE2eUser } from "../helpers/e2e/fixtures";
import { createE2eSpecContext, type E2eSpecContext } from "../helpers/e2e/spec-context";
import { adminClient } from "../helpers/test-env";

function toBase64Url(buffer: Buffer): string {
	return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function createEmailUnsubscribeToken(userId: string, email: string): string {
	const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
	if (!secret) {
		throw new Error("UNSUBSCRIBE_TOKEN_SECRET is required to build unsubscribe token");
	}
	const expiresAtMs = Date.now() + 1000 * 60 * 60 * 24 * 30;
	const payload = `${userId}.${email}.${expiresAtMs}`;
	const signature = createHmac("sha256", secret).update(payload).digest();
	return `${expiresAtMs}.${toBase64Url(signature)}`;
}

test.describe("dashboard and assets", () => {
	let e2e: E2eSpecContext;

	test.beforeAll(async ({ browser }) => {
		e2e = await createE2eSpecContext(browser);
	});

	test("TC-DASH-001: New user dashboard has correct initial state", async ({ browser }) => {
		const user = await createApprovedE2eUser("dash-init");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/dashboard");
			await expectCurrentPath(session.page, "/dashboard");

			const emailSwitch = session.page.getByRole("switch", { name: "Email notifications" });
			await expect(emailSwitch).toHaveAttribute("aria-checked", "true");

			const smsSwitch = session.page.getByRole("switch", { name: "SMS notifications" });
			await expect(smsSwitch).toHaveAttribute("aria-checked", "false");
			await expect(session.page.locator("#phone")).not.toBeVisible();
			await expect(session.page.getByText("No assets tracked yet")).toBeVisible();
		} finally {
			await session.cleanup();
		}
	});

	test("TC-AST-001: User can add assets to track", async ({ browser }) => {
		test.setTimeout(60_000);
		const user = await createApprovedE2eUser("dash-assets");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await ensureAssetsExist(["AAPL", "MSFT", "GOOGL"]);
			await session.page.goto("/dashboard");
			await addAsset(session.page, "AAPL");
			await addAsset(session.page, "MSFT");
			await addAsset(session.page, "GOOGL");
			await waitForTrackedAssets(user.id, ["AAPL", "GOOGL", "MSFT"]);

			await session.page.reload();
			await expect(session.page.getByRole("button", { name: "Remove AAPL" })).toBeVisible();
			await expect(session.page.getByRole("button", { name: "Remove MSFT" })).toBeVisible();
			await expect(session.page.getByRole("button", { name: "Remove GOOGL" })).toBeVisible();
		} finally {
			await session.cleanup();
		}
	});

	test("TC-BADGE-001: Asset badges show logo, Stock, or ETF", async ({ browser }) => {
		test.setTimeout(60_000);
		const user = await createApprovedE2eUser("dash-badges");
		const session = await e2e.openSignedInPage(browser, user);
		const msftIconUrl =
			"https://api.massive.com/v1/reference/company-branding/d3d3Lm1pY3Jvc29mdC5jb20/images/2022-01-10_icon.png";
		const symbolsToRestore = ["AAPL", "MSFT", "GOOGL", "NVDA"] as const;
		const originalIconUrls = new Map<string, string | null>();

		const assertNoDbError = (error: { message: string } | null, action: string) => {
			if (error) throw new Error(`${action}: ${error.message}`);
		};

		try {
			for (const symbol of symbolsToRestore) {
				const { data, error } = await adminClient
					.from("assets")
					.select("icon_url")
					.eq("symbol", symbol)
					.maybeSingle();
				assertNoDbError(error, `Failed to read ${symbol} icon_url`);
				originalIconUrls.set(symbol, data?.icon_url ?? null);
			}

			const { error: aaplErr } = await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "AAPL");
			assertNoDbError(aaplErr, "Failed to clear AAPL icon_url");

			const { error: msftErr } = await adminClient
				.from("assets")
				.update({ icon_url: msftIconUrl })
				.eq("symbol", "MSFT");
			assertNoDbError(msftErr, "Failed to set MSFT icon_url");

			const { error: googlErr } = await adminClient
				.from("assets")
				.update({ icon_url: "https://invalid.test/broken-icon.png" })
				.eq("symbol", "GOOGL");
			assertNoDbError(googlErr, "Failed to set GOOGL icon_url");

			await ensureAssetsExist(["AAPL", "MSFT", "GOOGL", "VOO"]);
			await session.page.goto("/dashboard");
			await addAsset(session.page, "AAPL");
			await addAsset(session.page, "MSFT");
			await addAsset(session.page, "GOOGL");
			await addAsset(session.page, "VOO");
			await waitForTrackedAssets(user.id, ["AAPL", "GOOGL", "MSFT", "VOO"]);
			await session.page.reload();

			const getRow = (symbol: string) =>
				session.page
					.getByRole("button", { name: `Remove ${symbol}` })
					.locator("xpath=ancestor::li");

			await expect(
				getRow("MSFT")
					.locator(`img[alt="MSFT logo"]`)
					.or(getRow("MSFT").getByText("Stock", { exact: true })),
			).toBeVisible({ timeout: 15_000 });
			await expect(getRow("AAPL").getByText("Stock", { exact: true })).toBeVisible();
			await expect(
				getRow("GOOGL")
					.locator(`img[alt="GOOGL logo"]`)
					.or(getRow("GOOGL").getByText("Stock", { exact: true })),
			).toBeVisible({ timeout: 15_000 });
			await expect(getRow("VOO").getByText("ETF", { exact: true })).toBeVisible();

			await ensureAssetsExist(["NVDA"]);
			const { error: nvdaErr } = await adminClient
				.from("assets")
				.update({ icon_url: msftIconUrl })
				.eq("symbol", "NVDA");
			assertNoDbError(nvdaErr, "Failed to set NVDA icon_url");

			const input = session.page.locator("#asset_search");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });
			await input.fill("NVDA");
			const dropdown = session.page.locator("#asset_dropdown");
			const nvdaOption = dropdown
				.getByRole("option")
				.filter({ hasText: new RegExp(`${escapeRegExp("NVDA")}\\s+-`) });
			await expect(nvdaOption).toBeVisible({ timeout: 30_000 });
			await expect(
				nvdaOption.locator(`img[alt="NVDA logo"]`).or(nvdaOption.getByText("Stock")),
			).toBeVisible();
		} finally {
			for (const symbol of symbolsToRestore) {
				await adminClient
					.from("assets")
					.update({ icon_url: originalIconUrls.get(symbol) ?? null })
					.eq("symbol", symbol);
			}
			await session.cleanup();
		}
	});

	test("TC-EMAIL-001: User can enable email notifications via dashboard", async ({ browser }) => {
		test.setTimeout(90_000);
		const user = await createApprovedE2eUser("dash-email");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await ensureAssetsExist(["AAPL"]);
			await session.page.goto("/dashboard");
			await addAsset(session.page, "AAPL");
			await waitForTrackedAssets(user.id, ["AAPL"]);
			await session.page
				.locator('form[aria-label="Notification preferences"][data-hydrated]')
				.waitFor({ timeout: 15_000 });

			const emailSwitch = session.page.getByRole("switch", { name: "Email notifications" });
			if ((await emailSwitch.getAttribute("aria-checked")) !== "true") {
				await waitForAutosave(session.page, async () => {
					await emailSwitch.click();
				});
				await waitForEmailNotificationsEnabled(user.id, true);
			}

			const marketNotificationsForm = session.page.locator(
				'form[aria-label="Market notifications"]',
			);
			await expect(marketNotificationsForm).toBeVisible({ timeout: 15_000 });
			await marketNotificationsForm.scrollIntoViewIfNeeded();
			// Enable Email for scheduled price notifications via the channel multiselect
			// (the per-option checkbox is now a channel dropdown). Selecting Email also
			// enables the scheduled-price section so a delivery time can be added.
			const scheduledTrigger = session.page.locator(
				"#market_scheduled_asset_price-channel-trigger",
			);
			await expect(scheduledTrigger).toBeVisible({ timeout: 15_000 });
			await scheduledTrigger.scrollIntoViewIfNeeded();
			if (!((await scheduledTrigger.textContent()) ?? "").includes("Email")) {
				await scheduledTrigger.click();
				const scheduledListbox = session.page.locator(
					"#market_scheduled_asset_price-channel-listbox",
				);
				await expect(scheduledListbox).toBeVisible();
				await waitForAutosave(session.page, async () => {
					await scheduledListbox.getByRole("option", { name: "Email" }).click();
				});
				// Close the (multi-select) listbox so it doesn't overlay the time controls.
				await scheduledTrigger.click();
				await expect
					.poll(
						async () => {
							const { data, error } = await adminClient
								.from("notification_preferences")
								.select("enabled")
								.eq("user_id", user.id)
								.eq("notification_type", "market_scheduled_asset_price")
								.eq("content", "")
								.eq("channel", "email")
								.maybeSingle();
							if (error) {
								throw new Error(`Failed to read scheduled email preference: ${error.message}`);
							}
							return data?.enabled ?? false;
						},
						{ timeout: 30_000 },
					)
					.toBe(true);
			}

			const marketOpenButton = marketNotificationsForm.getByRole("button", {
				name: /Set delivery time to after US market open/i,
			});
			await expect(marketOpenButton).toBeVisible({ timeout: 15_000 });
			await expect(marketOpenButton).toBeEnabled();
			await marketOpenButton.click();
			await expect
				.poll(
					async () => {
						const { data, error } = await adminClient
							.from("users")
							.select("market_scheduled_asset_price_times")
							.eq("id", user.id)
							.single();
						if (error) {
							throw new Error(`Failed to read delivery times: ${error.message}`);
						}
						return Array.isArray(data.market_scheduled_asset_price_times)
							? data.market_scheduled_asset_price_times.length
							: 0;
					},
					{ timeout: 30_000 },
				)
				.toBeGreaterThan(0);

			await expect
				.poll(
					async () => {
						const { data, error } = await adminClient
							.from("users")
							.select("email_notifications_enabled,market_scheduled_asset_price_times")
							.eq("id", user.id)
							.single();
						if (error) {
							throw new Error(`Failed to verify email notification preferences: ${error.message}`);
						}
						const { data: pref, error: prefError } = await adminClient
							.from("notification_preferences")
							.select("enabled")
							.eq("user_id", user.id)
							.eq("notification_type", "market_scheduled_asset_price")
							.eq("content", "")
							.eq("channel", "email")
							.maybeSingle();
						if (prefError) {
							throw new Error(`Failed to verify scheduled email preference: ${prefError.message}`);
						}
						return (
							data.email_notifications_enabled === true &&
							pref?.enabled === true &&
							Array.isArray(data.market_scheduled_asset_price_times) &&
							data.market_scheduled_asset_price_times.length > 0
						);
					},
					{ timeout: 30_000 },
				)
				.toBe(true);

			await session.page.reload();
			await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
			// The scheduled-price Email selection persists across reload (multiselect summary).
			await expect(
				session.page.locator("#market_scheduled_asset_price-channel-trigger"),
			).toContainText("Email");
		} finally {
			await session.cleanup();
		}
	});

	test("TC-NOTIF-001: Notification preferences persist on reload", async ({ browser }) => {
		const user = await createApprovedE2eUser("dash-notif");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/dashboard");
			await session.page
				.locator('form[aria-label="Notification preferences"][data-hydrated]')
				.waitFor({ timeout: 15_000 });

			const emailSwitch = session.page.getByRole("switch", { name: "Email notifications" });
			await waitForAutosave(session.page, async () => {
				await emailSwitch.click();
			});
			await waitForEmailNotificationsEnabled(user.id, false);

			await session.page.goto("/dashboard");
			await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
		} finally {
			await session.cleanup();
		}
	});

	test("TC-UNSUB-001: User can unsubscribe via email link", async ({ browser }) => {
		const user = await createApprovedE2eUser("dash-unsub");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			const token = createEmailUnsubscribeToken(user.id, user.email);
			const unsubscribeUrl = `${session.baseOrigin}/unsubscribe?user=${encodeURIComponent(user.id)}&token=${encodeURIComponent(token)}`;
			await session.page.goto(unsubscribeUrl);
			await expect(session.page.getByText("Email notifications are now turned off.")).toBeVisible();

			await session.page.goto("/dashboard");
			const emailSwitch = session.page.getByRole("switch", { name: "Email notifications" });
			await waitForEmailNotificationsEnabled(user.id, false);
			await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
		} finally {
			await session.cleanup();
		}
	});

	test("TC-AUTH-002: Dashboard state persists across sign-out and sign-in", async ({ browser }) => {
		test.setTimeout(60_000);
		const user = await createApprovedE2eUser("dash-persist");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await ensureAssetsExist(["AAPL"]);
			await session.page.goto("/dashboard");
			await addAsset(session.page, "AAPL");
			await waitForTrackedAssets(user.id, ["AAPL"]);

			await session.page.getByRole("button", { name: "Sign Out" }).click();
			await expectCurrentPath(session.page, "/");
			await session.page.goto("/dashboard");
			await expectCurrentPath(session.page, "/auth/signin");
			await signIn(session.page, user.email, user.password);

			await expect(session.page.getByRole("button", { name: "Remove AAPL" })).toBeVisible();
			await expect(
				session.page.getByRole("switch", { name: "Email notifications" }),
			).toHaveAttribute("aria-checked", "true");
		} finally {
			await session.cleanup();
		}
	});
});
