import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { TEST_PASSWORD } from "../constants";
import { adminClient } from "../test-env";
import { cleanupTestUser, createTestEmail, createTestUser } from "../test-user";
import { expectCurrentPath } from "./auth";
import { buildAuthStorageState } from "./storage-state";

export type ApprovedE2eUser = {
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

/**
 * Open an authenticated dashboard session via cookie injection.
 * Use for scenario setup only — browser sign-in belongs in auth-flow specs
 * (TC-AUTH-001, TC-REC-001, TC-AUTH-002, etc.).
 */
export async function openSignedInPage(
	browser: Browser,
	user: ApprovedE2eUser,
	options: { baseOrigin?: string } = {},
): Promise<{ page: Page; baseOrigin: string; cleanup: () => Promise<void> }> {
	let baseOrigin = options.baseOrigin;
	if (!baseOrigin) {
		const probeContext = await browser.newContext();
		const probePage = await probeContext.newPage();
		await probePage.goto("/");
		baseOrigin = new URL(probePage.url()).origin;
		await probeContext.close();
	}

	const storageState = await buildAuthStorageState(baseOrigin, user.email, user.password);
	const context = await browser.newContext({ storageState });
	const page = await context.newPage();
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
