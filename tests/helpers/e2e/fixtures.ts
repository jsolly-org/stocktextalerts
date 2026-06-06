import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { TEST_PASSWORD } from "../constants";
import { adminClient } from "../test-env";
import { cleanupTestUser, createTestEmail, createTestUser } from "../test-user";
import { addAuthCookies, expectCurrentPath } from "./auth";

type ApprovedE2eUser = {
	id: string;
	email: string;
	password: string;
};

export async function createApprovedE2eUser(prefix = "e2e"): Promise<ApprovedE2eUser> {
	const email = createTestEmail(prefix);
	const user = await createTestUser({
		email,
		password: TEST_PASSWORD,
		confirmed: true,
		approved: true,
		emailNotificationsEnabled: true,
		marketScheduledAssetPriceIncludeEmail: false,
	});
	await waitForPasswordSignInReady(email, TEST_PASSWORD);
	return { id: user.id, email, password: TEST_PASSWORD };
}

export async function waitForPasswordSignInReady(email: string, password: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const { data, error } = await adminClient.auth.signInWithPassword({ email, password });
				return !error && Boolean(data.session);
			},
			{
				timeout: 30_000,
				message: "Auth user not ready for password sign-in",
			},
		)
		.toBe(true);
	await adminClient.auth.signOut();
}

export async function openSignedInPage(
	browser: Browser,
	user: ApprovedE2eUser,
): Promise<{ page: Page; baseOrigin: string; cleanup: () => Promise<void> }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto("/");
	const baseOrigin = new URL(page.url()).origin;
	await addAuthCookies(context, baseOrigin, user.email, user.password);
	await page.goto("/dashboard");
	await expectCurrentPath(page, "/dashboard");
	return {
		page,
		baseOrigin,
		cleanup: async () => {
			await context.close();
			await cleanupTestUser(user.id);
		},
	};
}
