import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { addAuthCookies, signInAndExpectPath } from "../helpers/e2e/auth";
import { waitForPasswordSignInReady } from "../helpers/e2e/fixtures";
import { extractLinks, rewriteLinkOrigin } from "../helpers/e2e/mail";
import { clearMailpit, waitForMailpitMessageTo } from "../helpers/mailpit";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

const WORKFLOW_ADMIN_EMAIL = "workflow-admin-e2e@example.com";

async function getUserRowByEmail(
	email: string,
): Promise<{ id: string; approved_at: string | null }> {
	const { data, error } = await adminClient
		.from("users")
		.select("id, approved_at")
		.eq("email", email)
		.single();
	if (error) throw new Error(`Failed to load user row: ${error.message}`);
	return data;
}

async function deleteUserByEmail(email: string): Promise<void> {
	const { data } = await adminClient.from("users").select("id").eq("email", email).maybeSingle();
	if (data?.id) {
		await cleanupTestUser(data.id);
	}
	const { data: authUsers, error } = await adminClient.auth.admin.listUsers({
		page: 1,
		perPage: 1000,
	});
	if (error) {
		throw new Error(`Failed to list auth users: ${error.message}`);
	}
	const matchingAuthUsers = authUsers.users.filter(
		(user) => user.email?.toLowerCase() === email.toLowerCase(),
	);
	for (const user of matchingAuthUsers) {
		const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
		if (deleteError) {
			throw new Error(`Failed to delete auth user ${user.id}: ${deleteError.message}`);
		}
	}
}

test("registration approval workflow sends admin and user emails", async ({ browser }) => {
	test.slow();
	test.setTimeout(120_000);

	const userEmail = `approval-workflow-${randomUUID()}@example.com`;
	let adminId: string | null = null;
	let userId: string | null = null;
	let adminContext: BrowserContext | null = null;
	let userContext: BrowserContext | null = null;
	let approvedUserContext: BrowserContext | null = null;

	try {
		await deleteUserByEmail(WORKFLOW_ADMIN_EMAIL);
		const admin = await createTestUser({
			email: WORKFLOW_ADMIN_EMAIL,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		adminId = admin.id;
		await waitForPasswordSignInReady(WORKFLOW_ADMIN_EMAIL, TEST_PASSWORD);

		userContext = await browser.newContext();
		const userPage = await userContext.newPage();
		await userPage.goto("/", { waitUntil: "networkidle" });
		const baseOrigin = new URL(userPage.url()).origin;

		await clearMailpit();
		await userPage.goto("/auth/register");
		await userPage.locator("#email").fill(userEmail);
		await userPage.locator("#password").fill(TEST_PASSWORD);
		await userPage.getByRole("button", { name: "Create account" }).click();
		await expect(userPage).toHaveURL(/\/auth\/unconfirmed/, { timeout: 15_000 });

		const confirmationEmail = await waitForMailpitMessageTo(userEmail, { timeoutMs: 60_000 });
		expect(confirmationEmail.subject).toContain("Confirm your email");
		const confirmationLink = extractLinks(
			`${confirmationEmail.html}\n${confirmationEmail.text}`,
		).find(
			(link) =>
				(link.includes("token_hash=") || link.includes("token=")) &&
				(link.includes("type=signup") || link.includes("type=email")),
		);
		expect(confirmationLink).toBeTruthy();
		if (!confirmationLink) throw new Error("Confirmation email link not found");

		const adminNotification = await waitForMailpitMessageTo(WORKFLOW_ADMIN_EMAIL, {
			timeoutMs: 15_000,
		});
		expect(adminNotification.subject).toContain(
			"New StockTextAlerts registration pending approval",
		);
		expect(adminNotification.text).toContain(userEmail);
		expect(adminNotification.text).toContain("http://localhost:4322/admin/users");

		await userPage.goto(rewriteLinkOrigin(confirmationLink, baseOrigin));
		await expect(userPage.getByRole("button", { name: "Verify my email" })).toBeVisible();
		await userPage.getByRole("button", { name: "Verify my email" }).click();
		await expect(userPage.getByText("Email Verified!")).toBeVisible();

		const createdUser = await getUserRowByEmail(userEmail);
		userId = createdUser.id;
		expect(createdUser.approved_at).toBeNull();
		await waitForPasswordSignInReady(userEmail, TEST_PASSWORD);

		approvedUserContext = await browser.newContext();
		const pendingPage = await approvedUserContext.newPage();
		await signInAndExpectPath(pendingPage, userEmail, TEST_PASSWORD, "/auth/pending-approval");

		adminContext = await browser.newContext();
		await addAuthCookies(adminContext, baseOrigin, WORKFLOW_ADMIN_EMAIL, TEST_PASSWORD);
		const adminPage = await adminContext.newPage();
		const dashboardResponse = await adminPage.goto("/dashboard");
		expect(dashboardResponse?.status()).toBe(200);

		await clearMailpit();
		await adminPage.goto("/admin/users");
		const row = adminPage.locator("li", { hasText: userEmail });
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: "Approve" }).click();
		await expect(adminPage).toHaveURL(/\/admin\/users\?success=approved$/, { timeout: 15_000 });
		await expect(adminPage.getByText(userEmail)).toHaveCount(0);

		const approvalEmail = await waitForMailpitMessageTo(userEmail, { timeoutMs: 15_000 });
		expect(approvalEmail.subject).toContain("Your StockTextAlerts account is approved");
		expect(approvalEmail.text).toContain("Your StockTextAlerts account has been approved.");
		expect(approvalEmail.text).toContain("http://localhost:4322/auth/signin");

		const approvedUser = await getUserRowByEmail(userEmail);
		expect(approvedUser.approved_at).toBeTruthy();

		const approvedSignInContext = await browser.newContext();
		try {
			const approvedSignInPage = await approvedSignInContext.newPage();
			await signInAndExpectPath(approvedSignInPage, userEmail, TEST_PASSWORD, "/dashboard");
		} finally {
			await approvedSignInContext.close();
		}
	} finally {
		for (const id of [userId, adminId]) {
			if (!id) continue;
			try {
				await cleanupTestUser(id);
			} catch (error) {
				rootLogger.warn("Failed to cleanup registration approval workflow test user", {
					context: { error },
				});
			}
		}
		await adminContext?.close();
		await userContext?.close();
		await approvedUserContext?.close();
	}
});
