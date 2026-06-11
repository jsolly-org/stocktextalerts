import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/constants", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/constants")>();
	return { ...actual, REGISTRATION_ENABLED: true };
});

import { rootLogger } from "../../src/lib/logging";
import AdminUsersPage from "../../src/pages/admin/users.astro";
import AuthForgotPage from "../../src/pages/auth/forgot.astro";
import AuthPendingApprovalPage from "../../src/pages/auth/pending-approval.astro";
import AuthRecoverPage from "../../src/pages/auth/recover.astro";
import AuthRegisterPage from "../../src/pages/auth/register.astro";
import SignInPage from "../../src/pages/auth/signin.astro";
import AuthUnconfirmedPage from "../../src/pages/auth/unconfirmed.astro";
import AuthVerifiedPage from "../../src/pages/auth/verified.astro";
import DashboardPage from "../../src/pages/dashboard.astro";
import IndexPage from "../../src/pages/index.astro";
import PrivacyPage from "../../src/pages/privacy.astro";
import ProfilePage from "../../src/pages/profile.astro";
import TermsPage from "../../src/pages/terms.astro";
import { TEST_PASSWORD } from "../helpers/constants";
import { createAuthenticatedCookies } from "../helpers/test-env";
import { cleanupTestUser, createTestEmail, createTestUser } from "../helpers/test-user";

function buildRequest(path: string, cookies?: Map<string, string>) {
	const headers = new Headers();
	if (cookies) {
		const cookieHeader = Array.from(cookies.entries())
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
		if (cookieHeader.length > 0) {
			headers.set("cookie", cookieHeader);
		}
	}

	return new Request(`http://localhost${path}`, { headers });
}

describe("Users can load pages without unexpected errors.", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("A visitor can view the landing page.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(IndexPage, {
			request: buildRequest("/"),
		});

		expect(response.status).toBe(200);
	});

	it("A logged-out visitor can view the sign-in page.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(SignInPage, {
			request: buildRequest("/auth/signin"),
		});

		expect(response.status).toBe(200);
	});

	it("A logged-out visitor is redirected to sign-in when opening the dashboard, with a return path.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(DashboardPage, {
			request: buildRequest("/dashboard"),
		});

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/auth/signin?redirect=%2Fdashboard");
	});

	it("An unapproved signed-in user is redirected to pending approval from the dashboard.", async () => {
		await withTestUser(
			{
				email: createTestEmail("pending"),
				password: TEST_PASSWORD,
				confirmed: true,
				approved: false,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(DashboardPage, {
					request: buildRequest("/dashboard", cookies),
				});

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe("/auth/pending-approval");
			},
		);
	});

	it("An unapproved signed-in user is redirected to pending approval from the profile page.", async () => {
		await withTestUser(
			{
				email: createTestEmail("pending-profile"),
				password: TEST_PASSWORD,
				confirmed: true,
				approved: false,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(ProfilePage, {
					request: buildRequest("/profile", cookies),
				});

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe("/auth/pending-approval");
			},
		);
	});

	async function withTestUser<T>(
		options: {
			email: string;
			password: string;
			confirmed: boolean;
			approved?: boolean;
		},
		callback: (user: { id: string; email: string }, cookies: Map<string, string>) => Promise<T>,
	): Promise<T> {
		const user = await createTestUser(options);
		try {
			const cookies = await createAuthenticatedCookies(user.email, options.password);
			return await callback(user, cookies);
		} finally {
			try {
				await cleanupTestUser(user.id);
			} catch (error) {
				rootLogger.warn("Cleanup failed", { error });
			}
		}
	}

	it("A signed-in user is redirected away from the sign-in page.", async () => {
		await withTestUser(
			{
				email: createTestEmail("test"),
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(SignInPage, {
					request: buildRequest("/auth/signin", cookies),
				});

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe("/dashboard");
			},
		);
	});

	it("A signed-in user who visits sign-in with a return path is redirected to that destination.", async () => {
		await withTestUser(
			{
				email: createTestEmail("test"),
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(SignInPage, {
					request: buildRequest("/auth/signin?redirect=/dashboard", cookies),
				});

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe("/dashboard");
			},
		);
	});

	const authPages = [
		{ component: SignInPage, path: "/auth/signin" },
		{ component: AuthRegisterPage, path: "/auth/register" },
		{ component: AuthPendingApprovalPage, path: "/auth/pending-approval" },
		{ component: AuthForgotPage, path: "/auth/forgot" },
		{ component: AuthRecoverPage, path: "/auth/recover" },
		{ component: AuthUnconfirmedPage, path: "/auth/unconfirmed" },
	];

	const staticPages = [
		{ component: PrivacyPage, path: "/privacy" },
		{ component: TermsPage, path: "/terms" },
	];

	it.each(authPages)("A visitor can access auth page $path.", async ({ component, path }) => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(component, {
			request: buildRequest(path),
		});

		expect(response.status).toBe(200);
	});

	it("Password entry pages render a single password field without confirm.", async () => {
		const container = await AstroContainer.create({ renderers });
		const registerResponse = await container.renderToResponse(AuthRegisterPage, {
			request: buildRequest("/auth/register"),
		});
		expect(registerResponse.status).toBe(200);
		const registerHtml = await registerResponse.text();
		expect(registerHtml).toContain('name="password"');
		expect(registerHtml).not.toContain('name="confirm"');

		const recoverResponse = await container.renderToResponse(AuthRecoverPage, {
			request: buildRequest("/auth/recover?token_hash=test-token&type=recovery"),
		});
		expect(recoverResponse.status).toBe(200);
		const recoverHtml = await recoverResponse.text();
		expect(recoverHtml).toContain('name="password"');
		expect(recoverHtml).not.toContain('name="confirm"');
	});

	it("The pending approval page explains the account status.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(AuthPendingApprovalPage, {
			request: buildRequest("/auth/pending-approval"),
		});

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Your account is pending approval");
	});

	it("A GET with token_hash renders a confirm button instead of immediately verifying.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(AuthVerifiedPage, {
			request: buildRequest("/auth/verified?token_hash=abc123&type=email"),
		});

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('name="token_hash"');
		expect(html).toContain('value="abc123"');
		expect(html).toContain("Verify my email");
		expect(html).not.toContain("Email Verified!");
	});

	it.each(staticPages)("A visitor can access static page $path.", async ({ component, path }) => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(component, {
			request: buildRequest(path),
		});

		expect(response.status).toBe(200);
	});

	it("A signed-in user can view the verified page.", async () => {
		await withTestUser(
			{
				email: createTestEmail("test"),
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(AuthVerifiedPage, {
					request: buildRequest("/auth/verified", cookies),
				});

				expect(response.status).toBe(200);
			},
		);
	});

	it("A signed-in user can access the dashboard.", async () => {
		await withTestUser(
			{
				email: createTestEmail("test"),
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });

				const dashboardResponse = await container.renderToResponse(DashboardPage, {
					request: buildRequest("/dashboard", cookies),
				});
				expect(dashboardResponse.status).toBe(200);
			},
		);
	});

	it("A signed-in user can access their profile.", async () => {
		await withTestUser(
			{
				email: createTestEmail("test"),
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });

				const profileResponse = await container.renderToResponse(ProfilePage, {
					request: buildRequest("/profile", cookies),
				});
				expect(profileResponse.status).toBe(200);
			},
		);
	});

	it("A logged-out visitor is redirected to sign-in when opening the admin users page.", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(AdminUsersPage, {
			request: buildRequest("/admin/users"),
		});

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/auth/signin?redirect=%2Fadmin%2Fusers");
	});

	it("A non-admin signed-in user cannot view the admin users page.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "test@jsolly.com");
		await withTestUser(
			{
				email: createTestEmail("not-admin"),
				password: TEST_PASSWORD,
				confirmed: true,
				approved: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(AdminUsersPage, {
					request: buildRequest("/admin/users", cookies),
				});

				expect(response.status).toBe(403);
			},
		);
	});

	it("An allowlisted admin can view pending users.", async () => {
		vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
		await withTestUser(
			{
				email: "admin@example.com",
				password: TEST_PASSWORD,
				confirmed: true,
				approved: true,
			},
			async (_admin, cookies) => {
				const pending = await createTestUser({
					email: createTestEmail("pending-admin-list"),
					password: TEST_PASSWORD,
					confirmed: true,
					approved: false,
				});
				try {
					const container = await AstroContainer.create({ renderers });
					const response = await container.renderToResponse(AdminUsersPage, {
						request: buildRequest("/admin/users", cookies),
					});
					const html = await response.text();

					expect(response.status).toBe(200);
					expect(html).toContain(pending.email);
					expect(html).toContain("/api/admin/users/approve");
				} finally {
					await cleanupTestUser(pending.id);
				}
			},
		);
	});
});
