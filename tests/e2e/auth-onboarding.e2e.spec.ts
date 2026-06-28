import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { REGISTRATION_ENABLED } from "../../src/lib/constants";
import { rootLogger } from "../../src/lib/logging";
import { NEW_PASSWORD, TEST_PASSWORD } from "../helpers/constants";
import { expectCurrentPath, fillEmailInput, signIn, signOut } from "../helpers/e2e/auth";
import { createApprovedE2eUser, openSignedInPage } from "../helpers/e2e/fixtures";
import { extractLinks, rewriteLinkOrigin, waitForEmail } from "../helpers/e2e/mail";
import { clearMailpit } from "../helpers/mailpit";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

test.describe("auth onboarding", () => {
	test("TC-REG-001: User can register and lands on pending approval after email confirmation", async ({
		browser,
	}) => {
		test.slow();
		test.setTimeout(120_000);

		if (!REGISTRATION_ENABLED) {
			test.skip();
		}

		const testEmail = `register-${randomUUID()}@example.com`;
		let userId: string | null = null;
		const context = await browser.newContext();
		const page = await context.newPage();

		try {
			await page.goto("/");
			const baseOrigin = new URL(page.url()).origin;

			await page.goto("/auth/register");
			await expect(page.getByLabel("Password", { exact: false })).toBeVisible();
			await expect(page.locator("#confirm")).toHaveCount(0);
			await page.locator("#email").fill(testEmail);
			await page.locator("#password").fill(TEST_PASSWORD);
			await page.getByRole("button", { name: "Create account" }).click();
			await expectCurrentPath(page, "/auth/unconfirmed");

			const confirmationEmail = await waitForEmail(testEmail, "Confirm your email", 60_000);
			const confirmationLink = extractLinks(confirmationEmail).find(
				(link) =>
					(link.includes("token_hash=") || link.includes("token=")) &&
					(link.includes("type=signup") || link.includes("type=email")),
			);
			expect(confirmationLink).toBeTruthy();
			if (!confirmationLink) {
				throw new Error("Confirmation email link not found");
			}

			await page.goto(rewriteLinkOrigin(confirmationLink, baseOrigin));
			await expectCurrentPath(page, "/auth/verified");
			await page.getByRole("button", { name: "Verify my email" }).click();
			await expect(page.getByText("Email Verified!")).toBeVisible();

			const { data, error } = await adminClient
				.from("users")
				.select("id, approved_at")
				.eq("email", testEmail)
				.maybeSingle();
			if (error) {
				throw new Error(`Failed to resolve registered user: ${error.message}`);
			}
			expect(data?.id).toBeTruthy();
			expect(data?.approved_at).toBeNull();
			userId = data?.id ?? null;

			await signIn(page, testEmail, TEST_PASSWORD, { expectedPath: "/auth/pending-approval" });
			await expect(page.getByText("Your account is pending approval")).toBeVisible();
		} finally {
			await context.close();
			if (userId) {
				try {
					await cleanupTestUser(userId);
				} catch (error) {
					rootLogger.warn("Failed to cleanup registration test user", { error });
				}
			}
		}
	});

	test("TC-AUTH-001: User can sign out and sign back in", async ({ browser }) => {
		const user = await createApprovedE2eUser("auth-signout");
		const session = await openSignedInPage(browser, user);
		try {
			await signOut(session.page);
			await session.page.goto("/dashboard");
			await expectCurrentPath(session.page, "/auth/signin");
			await signIn(session.page, user.email, user.password);
		} finally {
			await session.cleanup();
		}
	});

	test("TC-REC-001: User can reset password via forgot and recover flow", async ({ browser }) => {
		test.slow();
		test.setTimeout(120_000);

		const recoverEmail = `recover-${randomUUID()}@example.com`;
		const recoverUser = await createTestUser({
			email: recoverEmail,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});

		const context = await browser.newContext();
		const page = await context.newPage();

		try {
			await page.goto("/", { waitUntil: "domcontentloaded" });
			const baseOrigin = new URL(page.url()).origin;

			await clearMailpit();
			await page.goto("/auth/forgot", { waitUntil: "networkidle" });
			await fillEmailInput(page, recoverEmail);
			const forgotResponse = page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					response.url().includes("/api/auth/email/forgot-password"),
				{ timeout: 60_000 },
			);
			await page.getByRole("button", { name: "Send Reset Link" }).click();
			const forgotPost = await forgotResponse;
			expect(forgotPost.status()).toBeGreaterThanOrEqual(300);
			expect(forgotPost.status()).toBeLessThan(400);

			const resetEmail = await waitForEmail(recoverEmail, "Reset your password", 60_000);
			const recoveryLink = extractLinks(resetEmail).find(
				(link) => link.includes("token_hash=") && link.includes("type=recovery"),
			);
			expect(recoveryLink).toBeTruthy();
			if (!recoveryLink) {
				throw new Error("Password reset email link not found");
			}

			await page.goto(rewriteLinkOrigin(recoveryLink, baseOrigin));
			await expect(page.getByLabel("New password")).toBeVisible();
			await expect(page.locator("#confirm")).toHaveCount(0);
			await page.locator("#password").fill(NEW_PASSWORD);
			await page.getByRole("button", { name: "Update password" }).click();

			await expect
				.poll(() => new URL(page.url()).pathname, {
					message: "Expected post-reset redirect to sign-in or dashboard",
					timeout: 15_000,
				})
				.toMatch(/^\/(auth\/signin|dashboard)$/);

			if (new URL(page.url()).pathname === "/dashboard") {
				await signOut(page);
			}

			await signIn(page, recoverEmail, NEW_PASSWORD);
		} finally {
			await context.close();
			await cleanupTestUser(recoverUser.id);
		}
	});
});
