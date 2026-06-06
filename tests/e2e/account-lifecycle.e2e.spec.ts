import { test } from "@playwright/test";
import { expectCurrentPath } from "../helpers/e2e/auth";
import { createApprovedE2eUser, openSignedInPage } from "../helpers/e2e/fixtures";

test.describe("account lifecycle", () => {
	test("TC-DEL-001: User can delete their account", async ({ browser }) => {
		const user = await createApprovedE2eUser("account-delete");
		const session = await openSignedInPage(browser, user);
		try {
			await session.page.goto("/profile");
			session.page.once("dialog", async (dialog) => {
				await dialog.accept();
			});
			await session.page.getByRole("button", { name: "Delete Account" }).click();
			await expectCurrentPath(session.page, "/");

			await session.page.goto("/dashboard");
			await expectCurrentPath(session.page, "/auth/signin");
		} finally {
			try {
				await session.cleanup();
			} catch {
				// Account deletion removes the user row; cleanup is best-effort.
			}
		}
	});
});
