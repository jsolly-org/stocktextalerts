import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rootLogger } from "../../src/lib/logging";
import AuthForgotPage from "../../src/pages/auth/forgot.astro";
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
import { TEST_PASSWORD } from "../constants";
import { allowConsoleWarnings, errorSpy, warnSpy } from "../setup";
import {
	cleanupTestUser,
	createAuthenticatedCookies,
	createTestEmail,
	createTestUser,
} from "../shared-utils";

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
		const unexpectedWarns: string[] = [];
		const unexpectedErrors: string[] = [];

		for (const call of warnSpy.mock.calls) {
			const [raw] = call;
			try {
				const log = JSON.parse(raw as string) as {
					level: string;
					message: string;
				};
				if (log.level === "warn" && !log.message.startsWith("Cleanup failed")) {
					unexpectedWarns.push(log.message);
				}
			} catch {
				unexpectedWarns.push(String(raw));
			}
		}

		for (const call of errorSpy.mock.calls) {
			const [raw] = call;
			try {
				const log = JSON.parse(raw as string) as {
					level: string;
					message: string;
				};
				if (log.level === "error") {
					unexpectedErrors.push(log.message);
				}
			} catch {
				unexpectedErrors.push(String(raw));
			}
		}

		if (unexpectedWarns.length > 0 || unexpectedErrors.length > 0) {
			const messages: string[] = [];
			if (unexpectedWarns.length > 0) {
				messages.push(`Unexpected warnings: ${unexpectedWarns.join(", ")}`);
			}
			if (unexpectedErrors.length > 0) {
				messages.push(`Unexpected errors: ${unexpectedErrors.join(", ")}`);
			}
			throw new Error(messages.join("; "));
		}

		if (warnSpy.mock.calls.length > 0) {
			allowConsoleWarnings();
		}
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
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?redirect=%2Fdashboard",
		);
	});

	async function withTestUser<T>(
		options: {
			email: string;
			password: string;
			confirmed: boolean;
		},
		callback: (
			user: { id: string; email: string },
			cookies: Map<string, string>,
		) => Promise<T>,
	): Promise<T> {
		const user = await createTestUser(options);
		try {
			const cookies = await createAuthenticatedCookies(
				user.email,
				options.password,
			);
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
		{ component: AuthForgotPage, path: "/auth/forgot" },
		{ component: AuthRecoverPage, path: "/auth/recover" },
		{ component: AuthUnconfirmedPage, path: "/auth/unconfirmed" },
	];

	const staticPages = [
		{ component: PrivacyPage, path: "/privacy" },
		{ component: TermsPage, path: "/terms" },
	];

	it.each(authPages)("A visitor can access auth page $path.", async ({
		component,
		path,
	}) => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(component, {
			request: buildRequest(path),
		});

		expect(response.status).toBe(200);
	});

	it.each(staticPages)("A visitor can access static page $path.", async ({
		component,
		path,
	}) => {
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

				const dashboardResponse = await container.renderToResponse(
					DashboardPage,
					{
						request: buildRequest("/dashboard", cookies),
					},
				);
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
});
