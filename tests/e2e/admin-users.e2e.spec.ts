import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rootLogger } from "../../src/lib/logging";
import { TEST_PASSWORD } from "../helpers/constants";
import { signIn } from "../helpers/e2e/auth";
import { clearMailpit, waitForMailpitMessageTo } from "../helpers/mailpit";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

// Must match ADMIN_EMAILS injected into the dev server in
// playwright.config.ts (webServer.env). @example.com keeps it non-routable.
const ADMIN_EMAIL = "admin-e2e@example.com";

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

async function getApprovedAt(userId: string): Promise<string | null> {
	const { data, error } = await adminClient
		.from("users")
		.select("approved_at")
		.eq("id", userId)
		.single();
	if (error) {
		throw new Error(`Failed to read approved_at: ${error.message}`);
	}
	return data.approved_at;
}

test.describe("admin pending-user approval", () => {
	test.describe.configure({ mode: "serial" });

	let context: BrowserContext;
	let page: Page;
	let adminId: string | null = null;
	let pendingId: string | null = null;
	let pendingEmail = "";

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();

		// Warm the Vite dev server before the first real navigation (see
		// delivery-times.e2e.spec.ts for the cold-start rationale).
		await page.goto("/", { waitUntil: "networkidle" });

		// Clear any leftover admin row from a prior interrupted run.
		await deleteUserByEmail(ADMIN_EMAIL);

		const admin = await createTestUser({
			email: ADMIN_EMAIL,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		adminId = admin.id;

		const pending = await createTestUser({
			email: `pending-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		pendingId = pending.id;
		pendingEmail = pending.email;
	});

	test.afterAll(async () => {
		for (const id of [adminId, pendingId]) {
			if (!id) continue;
			try {
				await cleanupTestUser(id);
			} catch (error) {
				rootLogger.warn("Failed to cleanup admin-users test user", { context: { error } });
			}
		}
		if (page) await page.close();
		if (context) await context.close();
	});

	test("a non-admin signed-in user is forbidden from /admin/users", async () => {
		const nonAdmin = await createTestUser({
			email: `not-admin-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: true,
		});
		try {
			await signIn(page, nonAdmin.email, TEST_PASSWORD);
			const response = await page.goto("/admin/users");
			expect(response?.status()).toBe(403);
			await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 5_000 });
		} finally {
			await cleanupTestUser(nonAdmin.id);
		}
	});

	test("an allowlisted admin can open /admin/users and see the pending user", async () => {
		await signIn(page, ADMIN_EMAIL, TEST_PASSWORD);

		const response = await page.goto("/admin/users");
		expect(response?.status()).toBe(200);

		await expect(page.getByRole("heading", { name: "Pending users" })).toBeVisible();
		await expect(page.getByText(pendingEmail)).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
	});

	test("approving the pending user updates the DB, removes them from the list, and sends email", async () => {
		expect(await getApprovedAt(pendingId as string)).toBeNull();
		await clearMailpit();

		await page.goto("/admin/users");
		const row = page.locator("li", { hasText: pendingEmail });
		await row.getByRole("button", { name: "Approve" }).click();

		await expect(page).toHaveURL(/\/admin\/users\?success=approved$/, {
			timeout: 15_000,
		});

		await expect(page.getByText(pendingEmail)).toHaveCount(0);
		expect(await getApprovedAt(pendingId as string)).not.toBeNull();

		const message = await waitForMailpitMessageTo(pendingEmail, { timeoutMs: 15_000 });
		expect(message.subject).toContain("Your StockTextAlerts account is approved");
		expect(message.text).toContain("Your StockTextAlerts account has been approved.");
		expect(message.text).toContain("http://localhost:4322/auth/signin");
	});
});
