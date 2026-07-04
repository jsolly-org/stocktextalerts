import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { createAuthenticatedCookies } from "../test-env";

export async function expectCurrentPath(
	page: Page,
	expectedPath: string,
	timeout = 15_000,
): Promise<void> {
	await expect
		.poll(() => new URL(page.url()).pathname, {
			message: `Expected path ${expectedPath}`,
			timeout,
		})
		.toBe(expectedPath);
}

/** Fill the email field on the sign-in / forgot / register forms. */
export async function fillEmailInput(page: Page, email: string): Promise<void> {
	const emailInput = page.locator("#email");
	await emailInput.waitFor({ state: "visible", timeout: 15_000 });
	await emailInput.fill(email);
	await expect(emailInput).toHaveValue(email, { timeout: 10_000 });
}

export async function signIn(
	page: Page,
	email: string,
	password: string,
	options: { expectedPath?: string } = {},
): Promise<void> {
	const expectedPath = options.expectedPath ?? "/dashboard";
	const signInTimeout = process.env.CI ? 60_000 : 30_000;
	// Fresh Playwright contexts often hit /auth/signin as their first navigation.
	// Warm the dev server before submit so the fields are ready and HTML5
	// validation can't block the POST (see delivery-times.e2e.spec.ts).
	const pageUrl = page.url();
	if (pageUrl === "about:blank" || pageUrl === "") {
		await page.goto("/", { waitUntil: "domcontentloaded", timeout: signInTimeout });
	}
	await page.goto("/auth/signin", { waitUntil: "networkidle", timeout: signInTimeout });
	await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled({
		timeout: signInTimeout,
	});
	await fillEmailInput(page, email);
	await page.locator("#password").fill(password);
	const signInResponse = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" && response.url().includes("/api/auth/signin"),
		{ timeout: signInTimeout },
	);
	await page.getByRole("button", { name: "Sign In" }).click();
	const response = await signInResponse;
	const status = response.status();
	expect(
		status >= 300 && status < 400,
		`Sign-in POST expected redirect, got status ${status}`,
	).toBe(true);
	await expectCurrentPath(page, expectedPath, signInTimeout);
}

export async function signOut(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Sign Out" }).click();
	await expectCurrentPath(page, "/");
}

export async function signInAndExpectPath(
	page: Page,
	email: string,
	password: string,
	expectedPath: string,
): Promise<void> {
	await signIn(page, email, password, { expectedPath });
}

export async function addAuthCookies(
	context: BrowserContext,
	baseOrigin: string,
	email: string,
	password: string,
): Promise<void> {
	const authCookies = await createAuthenticatedCookies(email, password);
	await context.addCookies([
		{
			name: "sb-access-token",
			value: authCookies.get("sb-access-token") ?? "",
			url: baseOrigin,
		},
		{
			name: "sb-refresh-token",
			value: authCookies.get("sb-refresh-token") ?? "",
			url: baseOrigin,
		},
	]);
}
