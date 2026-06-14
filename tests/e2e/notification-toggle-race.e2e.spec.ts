import { expect, test } from "@playwright/test";
import { expectCurrentPath } from "../helpers/e2e/auth";
import { createApprovedE2eUser } from "../helpers/e2e/fixtures";
import { createE2eSpecContext, type E2eSpecContext } from "../helpers/e2e/spec-context";
import { adminClient } from "../helpers/test-env";

const NOTIFICATION_PREFERENCES_UPDATE_URL = "/api/notification-preferences/update";

test.describe("notification toggle race", () => {
	let e2e: E2eSpecContext;

	test.beforeAll(async ({ browser }) => {
		e2e = await createE2eSpecContext(browser);
	});

	test("TC-NOTIF-002: a superseded notification-preferences save is cancelled and never clobbers the latest toggle", async ({
		browser,
	}) => {
		test.setTimeout(60_000);
		const user = await createApprovedE2eUser("notif-race");
		const session = await e2e.openSignedInPage(browser, user);
		try {
			await expectCurrentPath(session.page, "/dashboard");
			await session.page
				.locator('form[aria-label="Notification preferences"][data-hydrated]')
				.waitFor({ timeout: 15_000 });

			// Two independent channel toggles on the same form (so both saves run
			// through the same composable's save-sequencer). A fresh user starts with
			// Email ON and SMS OFF; neither toggle needs a verified phone or tracked
			// assets — the master SMS toggle persists without a phone (only the SMS
			// *include* fields gate on one). Flipping two distinct fields gives the
			// second save a distinct signature, so it isn't dropped by the
			// signature-dedup guard the way a re-toggle of one field would be.
			const emailSwitch = session.page.getByRole("switch", { name: "Email notifications" });
			const smsSwitch = session.page.getByRole("switch", { name: "SMS notifications" });
			await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
			await expect(smsSwitch).toHaveAttribute("aria-checked", "false");

			// Stall the FIRST save's response so it is still in flight when the second
			// toggle arrives. The save-sequencer aborts the in-flight first request
			// (last-write-wins by cancellation), so its response can never land late
			// and clobber the user's final choice. The pre-sequencer composable
			// instead queued saves and left the first request running, so this
			// scenario is what distinguishes the sequencer's behavior.
			let callIndex = 0;
			await session.page.route(`**${NOTIFICATION_PREFERENCES_UPDATE_URL}`, async (route) => {
				callIndex += 1;
				if (callIndex === 1) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
				try {
					await route.continue();
				} catch {
					// A superseded first save is aborted client-side, so its route can
					// no longer be continued — swallow that. The abort itself is
					// asserted below via `firstRequest.failure()`.
				}
			});

			// Save #1: turn Email OFF. The toggle autosaves on a 450ms debounce, so
			// wait until save #1 is genuinely in flight (and stalled) before touching
			// the second field — otherwise the two changes coalesce into a single
			// save and the overlap never happens.
			const firstRequestPromise = session.page.waitForRequest(
				`**${NOTIFICATION_PREFERENCES_UPDATE_URL}`,
			);
			await emailSwitch.click(); // save #1 (response stalled)
			const firstRequest = await firstRequestPromise;

			// Save #2: turn SMS ON while save #1 is still stalled. Its distinct
			// signature (email=off, sms=on) supersedes #1 and resolves first.
			await Promise.all([
				session.page.waitForResponse(
					(response) =>
						response.url().includes(NOTIFICATION_PREFERENCES_UPDATE_URL) &&
						response.status() === 200,
					{ timeout: 15_000 },
				),
				smsSwitch.click(), // save #2 supersedes #1
			]);

			// Both fields reflect the user's final intent, not save #1's stale snapshot
			// (which carried email=off, sms=off and would revert SMS if it landed).
			await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
			await expect(smsSwitch).toHaveAttribute("aria-checked", "true");

			// The defining sequencer behavior: the superseded first request was
			// cancelled (net::ERR_ABORTED), not left to complete. The pre-sequencer
			// queue never aborts, so this assertion fails on the old code.
			expect(firstRequest.failure()).not.toBeNull();

			// Give any late first-save settling a window to (incorrectly) touch the UI.
			await session.page.waitForTimeout(500);
			await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
			await expect(smsSwitch).toHaveAttribute("aria-checked", "true");

			// The persisted row agrees with the last write across both fields.
			await expect
				.poll(
					async () => {
						const { data, error } = await adminClient
							.from("users")
							.select("email_notifications_enabled,sms_notifications_enabled")
							.eq("id", user.id)
							.single();
						if (error) {
							throw new Error(`Failed to read notification preferences: ${error.message}`);
						}
						return data;
					},
					{ timeout: 15_000 },
				)
				.toEqual({ email_notifications_enabled: false, sms_notifications_enabled: true });

			// …and the UI agrees after a reload.
			await session.page.unroute(`**${NOTIFICATION_PREFERENCES_UPDATE_URL}`);
			await session.page.reload();
			await session.page
				.locator('form[aria-label="Notification preferences"][data-hydrated]')
				.waitFor({ timeout: 15_000 });
			await expect(
				session.page.getByRole("switch", { name: "Email notifications" }),
			).toHaveAttribute("aria-checked", "false");
			await expect(session.page.getByRole("switch", { name: "SMS notifications" })).toHaveAttribute(
				"aria-checked",
				"true",
			);
		} finally {
			await session.cleanup();
		}
	});
});
