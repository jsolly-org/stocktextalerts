import type { Browser, Page } from "@playwright/test";
import { cleanupTestUser } from "../test-user";
import { expectCurrentPath } from "./auth";
import type { ApprovedE2eUser } from "./fixtures";
import { buildAuthStorageState } from "./storage-state";

export type E2eSignedInSession = {
	page: Page;
	baseOrigin: string;
	cleanup: () => Promise<void>;
};

/**
 * Per-spec-file harness: resolves baseOrigin once and opens sessions via
 * Playwright storageState instead of per-test cookie injection + extra navigations.
 */
export type E2eSpecContext = {
	baseOrigin: string;
	openSignedInPage: (browser: Browser, user: ApprovedE2eUser) => Promise<E2eSignedInSession>;
};

export async function createE2eSpecContext(browser: Browser): Promise<E2eSpecContext> {
	const probeContext = await browser.newContext();
	const probePage = await probeContext.newPage();
	await probePage.goto("/");
	const baseOrigin = new URL(probePage.url()).origin;
	await probeContext.close();

	return {
		baseOrigin,
		async openSignedInPage(browserInstance, user) {
			const storageState = await buildAuthStorageState(baseOrigin, user.email, user.password);
			const context = await browserInstance.newContext({ storageState });
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
		},
	};
}
