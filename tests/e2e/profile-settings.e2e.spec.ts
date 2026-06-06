import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { NEW_PASSWORD } from "../helpers/constants";
import { expectCurrentPath, signIn, signOut } from "../helpers/e2e/auth";
import { createApprovedE2eUser } from "../helpers/e2e/fixtures";
import {
	confirmEmailChangeLinks,
	extractLinks,
	maybeWaitForEmail,
	uniqueEmailChangeLinksByToken,
	waitForEmail,
} from "../helpers/e2e/mail";
import { createE2eSpecContext, type E2eSpecContext } from "../helpers/e2e/spec-context";
import { adminClient } from "../helpers/test-env";

test.describe("profile settings", () => {
	let e2e: E2eSpecContext;

	test.beforeAll(async ({ browser }) => {
		e2e = await createE2eSpecContext(browser);
	});

	test("TC-TZ-001: User can configure timezone", async ({ browser }) => {
		const user = await createApprovedE2eUser("profile-tz");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await expectCurrentPath(session.page, "/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			const timezoneSelect = session.page.locator("#profile-timezone");
			const currentTimezone = await timezoneSelect.inputValue();
			const targetTimezone =
				currentTimezone === "America/Chicago" ? "America/New_York" : "America/Chicago";

			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/timezone") && response.status() === 200,
					{ timeout: 15_000 },
				),
				timezoneSelect.selectOption(targetTimezone),
			]);
			await expect(session.page.getByText("Timezone updated.")).toBeVisible({ timeout: 10_000 });
			await expect(timezoneSelect).toHaveValue(targetTimezone);

			await session.page.reload();
			await expectCurrentPath(session.page, "/profile");
			await expect(session.page.locator("#profile-timezone")).toHaveValue(targetTimezone);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-TIME-001: User can toggle 24-hour time format", async ({ browser }) => {
		const user = await createApprovedE2eUser("profile-time");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			const timeSwitch = session.page.getByRole("switch", { name: "Use 24-hour time" });
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/time-format") && response.status() === 200,
					{ timeout: 15_000 },
				),
				timeSwitch.click(),
			]);
			await expect(timeSwitch).toHaveAttribute("aria-checked", "true");
			await expect(session.page.getByText("Time format updated.")).toBeVisible({ timeout: 10_000 });

			await session.page.reload();
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });
			await expect(session.page.getByRole("switch", { name: "Use 24-hour time" })).toHaveAttribute(
				"aria-checked",
				"true",
			);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-PROF-PW-001: User can change password from profile", async ({ browser }) => {
		test.slow();
		const user = await createApprovedE2eUser("profile-pw");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await expect(session.page.getByLabel("New password")).toBeVisible();
			await expect(session.page.locator("#confirm-password")).toHaveCount(0);
			await session.page.locator("#new-password").fill(NEW_PASSWORD);
			await session.page.getByRole("button", { name: "Update password" }).click();
			await expectCurrentPath(session.page, "/profile");
			await expect(session.page.getByText("Password updated successfully!")).toBeVisible();

			await signOut(session.page);
			await signIn(session.page, user.email, NEW_PASSWORD);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-PROF-001: User can update email after changing password", async ({ browser }) => {
		test.slow();
		test.setTimeout(180_000);

		const user = await createApprovedE2eUser("profile-email");
		const secondEmail = `profile-second-${randomUUID()}@example.com`;
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await session.page.locator("#new-password").fill(NEW_PASSWORD);
			await session.page.getByRole("button", { name: "Update password" }).click();
			await expect(session.page.getByText("Password updated successfully!")).toBeVisible();

			await signOut(session.page);
			await signIn(session.page, user.email, NEW_PASSWORD);

			await session.page.goto("/profile");
			await session.page.locator("#new-email").fill(secondEmail);
			await session.page.getByRole("button", { name: "Update email" }).click();
			await expect(
				session.page.getByText("Check your old and new inboxes to confirm the email change."),
			).toBeVisible();

			const [newEmailMessage, oldEmailMessage] = await Promise.all([
				waitForEmail(secondEmail, "email change", 30_000),
				maybeWaitForEmail(user.email, "email change", 15_000),
			]);

			const candidateLinks = [
				...extractLinks(newEmailMessage),
				...(oldEmailMessage ? extractLinks(oldEmailMessage) : []),
			];
			const emailChangeLinks = uniqueEmailChangeLinksByToken(
				[...new Set(candidateLinks)].filter(
					(link) =>
						(link.includes("token_hash=") || link.includes("token=")) &&
						link.includes("type=email_change"),
				),
			);
			expect(emailChangeLinks.length).toBeGreaterThan(0);

			await confirmEmailChangeLinks(session.page, emailChangeLinks, session.baseOrigin);

			await expect
				.poll(
					async () => {
						const { data, error } = await adminClient
							.from("users")
							.select("email")
							.eq("id", user.id)
							.single();
						if (error) {
							throw new Error(`Failed to validate updated email: ${error.message}`);
						}
						return data.email;
					},
					{
						timeout: 30_000,
						message: "Email change did not sync to users.email after confirming inbox links",
					},
				)
				.toBe(secondEmail);

			await signIn(session.page, secondEmail, NEW_PASSWORD);
		} finally {
			await session.cleanup();
		}
	});
});
