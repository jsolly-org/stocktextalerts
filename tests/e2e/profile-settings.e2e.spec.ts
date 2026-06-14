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

	test("TC-TZ-002: a superseded timezone save is cancelled and never clobbers the latest value", async ({
		browser,
	}) => {
		const user = await createApprovedE2eUser("profile-tz-race");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await expectCurrentPath(session.page, "/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			const timezoneSelect = session.page.locator("#profile-timezone");
			const currentTimezone = await timezoneSelect.inputValue();
			// Two distinct active zones, both different from the starting value, so the
			// two selections produce two genuinely separate saves rather than
			// collapsing into one net-unchanged request.
			const [firstTarget, secondTarget] = [
				"America/New_York",
				"America/Chicago",
				"America/Los_Angeles",
			].filter((value) => value !== currentTimezone);
			if (!firstTarget || !secondTarget) {
				throw new Error(`Expected two timezone targets distinct from ${currentTimezone}`);
			}

			// Stall the FIRST save's response so it is still in flight when the second
			// selection arrives. The save-sequencer aborts the in-flight first request
			// (last-write-wins by cancellation), so its response can never land late
			// and clobber the user's final choice. The pre-refactor queue instead
			// serialized saves and left the first request running, so this scenario is
			// what distinguishes the sequencer's behavior.
			let callIndex = 0;
			await session.page.route("**/api/profile/timezone", async (route) => {
				callIndex += 1;
				if (callIndex === 1) {
					await new Promise((resolve) => setTimeout(resolve, 1500));
				}
				try {
					await route.continue();
				} catch {
					// A superseded first save is aborted client-side, so its route can
					// no longer be continued — swallow that. The abort itself is
					// asserted below via `firstRequest.failure()`.
				}
			});

			// Select firstTarget and wait until save #1 is actually in flight, then
			// select secondTarget while #1's response is still stalled so the two
			// genuinely overlap.
			const firstRequestPromise = session.page.waitForRequest("**/api/profile/timezone");
			await timezoneSelect.selectOption(firstTarget); // save #1 (response stalled)
			const firstRequest = await firstRequestPromise;
			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/timezone") && response.status() === 200,
					{ timeout: 15_000 },
				),
				timezoneSelect.selectOption(secondTarget), // save #2 supersedes #1
			]);
			await expect(session.page.getByText("Timezone updated.")).toBeVisible({ timeout: 10_000 });
			await expect(timezoneSelect).toHaveValue(secondTarget);

			// The defining sequencer behavior: the superseded first request was
			// cancelled (net::ERR_ABORTED), not left to complete. The pre-refactor
			// queue never aborts, so this assertion fails on the old code.
			expect(firstRequest.failure()).not.toBeNull();

			// Give any late first-save settling a window to (incorrectly) touch the UI.
			await session.page.waitForTimeout(500);
			await expect(timezoneSelect).toHaveValue(secondTarget);

			// …and the persisted value agrees after a reload.
			await session.page.unroute("**/api/profile/timezone");
			await session.page.reload();
			await expectCurrentPath(session.page, "/profile");
			await expect(session.page.locator("#profile-timezone")).toHaveValue(secondTarget);
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

	test("TC-TIME-002: rapid toggling never leaves the switch on a stale value", async ({
		browser,
	}) => {
		const user = await createApprovedE2eUser("profile-time-race");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			// Hold the FIRST save (turning ON) open until we explicitly release it
			// to fail, while the SECOND save (turning back OFF) succeeds first. On
			// the pre-fix code, the first save's late failure blindly reverted the
			// switch to the *current* value, flipping it back to ON even though the
			// user's final, persisted choice is OFF — a frontend/backend mismatch.
			// The save-sequencer supersedes (aborts) the first save, so its late
			// outcome can no longer touch the UI. Releasing explicitly (rather than
			// racing a timer) keeps the ordering deterministic.
			let releaseFirstSave!: () => void;
			const firstSaveReleased = new Promise<void>((resolve) => {
				releaseFirstSave = resolve;
			});
			let callIndex = 0;
			await session.page.route("**/api/profile/time-format", async (route) => {
				callIndex += 1;
				if (callIndex === 1) {
					await firstSaveReleased;
					try {
						await route.fulfill({
							status: 500,
							contentType: "application/json",
							body: JSON.stringify({ ok: false, message: "boom" }),
						});
					} catch {
						// Superseded saves are aborted client-side; the route can no
						// longer be fulfilled, which is exactly the fixed behavior.
					}
				} else {
					await route.continue();
				}
			});

			const timeSwitch = session.page.getByRole("switch", { name: "Use 24-hour time" });
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

			// Click ON and wait until save #1 is actually in flight before clicking
			// OFF, so the two saves genuinely overlap (otherwise they could collapse
			// into a single net-unchanged save and the race would never occur).
			const firstRequest = session.page.waitForRequest("**/api/profile/time-format");
			await timeSwitch.click(); // -> ON  (save #1, held open)
			await firstRequest;
			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/time-format") && response.status() === 200,
					{ timeout: 15_000 },
				),
				timeSwitch.click(), // -> OFF (save #2, succeeds and supersedes #1)
			]);
			// Save #2 has applied on both the pre-fix and fixed code at this point.
			await expect(session.page.getByText("Time format updated.")).toBeVisible({ timeout: 10_000 });

			// Now let save #1 fail. On pre-fix code this drives the buggy revert
			// (flipping the switch back to ON); with the fix, save #1 was already
			// aborted by save #2 and its failure is ignored. The release is ordered
			// after save #2's success, so the settle below is bounded, not a race.
			releaseFirstSave();
			await session.page.waitForTimeout(500);

			// The switch must reflect the user's last intent (OFF), not save #1's
			// superseded, late-failing ON.
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

			// …and the persisted value agrees after a reload.
			await session.page.unroute("**/api/profile/time-format");
			await session.page.reload();
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });
			await expect(session.page.getByRole("switch", { name: "Use 24-hour time" })).toHaveAttribute(
				"aria-checked",
				"false",
			);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-TIME-003: a failed save reverts the switch and surfaces the error without a phantom resave", async ({
		browser,
	}) => {
		const user = await createApprovedE2eUser("profile-time-fail");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			// Fail only the first save (the ON attempt); any later save would
			// succeed. The reverting write must NOT re-trigger the save watcher —
			// otherwise a phantom second POST fires and overwrites the error with a
			// false "Time format updated." (the exact desync the suppression guards).
			let postCount = 0;
			await session.page.route("**/api/profile/time-format", async (route) => {
				postCount += 1;
				if (postCount === 1) {
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ ok: false, message: "boom" }),
					});
				} else {
					await route.continue();
				}
			});

			const timeSwitch = session.page.getByRole("switch", { name: "Use 24-hour time" });
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/time-format") && response.status() === 500,
					{ timeout: 15_000 },
				),
				timeSwitch.click(), // -> ON (save fails)
			]);

			// Settle window for any (buggy) phantom resave triggered by the revert.
			await session.page.waitForTimeout(500);

			// Exactly one POST: the revert must not re-enter the save path.
			expect(postCount).toBe(1);
			// The switch reverted to its confirmed value, the error is surfaced, and
			// no false success message replaced it.
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");
			await expect(
				session.page.getByText("Failed to update time format. Please try again."),
			).toBeVisible();
			await expect(session.page.getByText("Time format updated.")).toHaveCount(0);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-TIME-004: time-format status announces via a persistent live region on success and failure", async ({
		browser,
	}) => {
		const user = await createApprovedE2eUser("profile-time-live");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			await session.page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

			// The live region is the always-mounted aria-atomic wrapper inside the
			// time-format card. It must pre-exist (empty) so screen readers announce
			// text that appears later — AT listens for mutations inside an existing
			// region, not for the region's insertion.
			const liveRegion = session.page.locator(
				'[aria-labelledby="time-format-heading"] [aria-atomic="true"]',
			);
			await expect(liveRegion).toHaveCount(1);
			await expect(liveRegion).toBeEmpty();
			// Politeness is static — it must NOT mutate with tone, or the attribute
			// change would race the text and the announcement could be dropped.
			await expect(liveRegion).toHaveAttribute("aria-live", "polite");

			const timeSwitch = session.page.getByRole("switch", { name: "Use 24-hour time" });
			await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

			// Success: the message lands inside the same persistent region.
			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/time-format") && response.status() === 200,
					{ timeout: 15_000 },
				),
				timeSwitch.click(),
			]);
			await expect(timeSwitch).toHaveAttribute("aria-checked", "true");
			await expect(liveRegion).toContainText("Time format updated.");

			// Failure: force the save to fail. The control must silently revert AND
			// the same region must announce the failure (the AT-desync this guards).
			// A 500 with a JSON body takes the non-throwing branch (no error log), so
			// no console.error noise is produced.
			await session.page.route("**/api/profile/time-format", (route) =>
				route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ ok: false }),
				}),
			);
			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes("/api/profile/time-format") && response.status() === 500,
					{ timeout: 15_000 },
				),
				timeSwitch.click(),
			]);
			await expect(liveRegion).toContainText("Failed to update time format");
			await expect(timeSwitch).toHaveAttribute("aria-checked", "true");
			// The region's politeness stayed stable across the success→error tone flip.
			await expect(liveRegion).toHaveAttribute("aria-live", "polite");
		} finally {
			await session.page.unroute("**/api/profile/time-format").catch(() => {});
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
