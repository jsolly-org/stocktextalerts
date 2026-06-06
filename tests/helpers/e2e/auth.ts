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

async function fillEmailInput(page: Page, email: string): Promise<void> {
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
}

export async function signIn(
	page: Page,
	email: string,
	password: string,
	options: { expectedPath?: string } = {},
): Promise<void> {
	const expectedPath = options.expectedPath ?? "/dashboard";
	await page.goto("/auth/signin");
	await fillEmailInput(page, email);
	await page.locator("#password").fill(password);
	const signInResponse = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" && response.url().includes("/api/auth/signin"),
		{ timeout: 30_000 },
	);
	await page.getByRole("button", { name: "Sign In" }).click();
	const response = await signInResponse;
	const status = response.status();
	expect(
		status >= 300 && status < 400,
		`Sign-in POST expected redirect, got status ${status}`,
	).toBe(true);
	await expectCurrentPath(page, expectedPath, 30_000);
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
