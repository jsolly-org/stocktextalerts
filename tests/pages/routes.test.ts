import { loadRenderers } from "astro:container";
import { randomUUID } from "node:crypto";
import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import { rootLogger } from "../../src/lib/logging";
import AuthForgotPage from "../../src/pages/auth/forgot.astro";
import AuthRecoverPage from "../../src/pages/auth/recover.astro";
import AuthRegisterPage from "../../src/pages/auth/register.astro";
import AuthUnconfirmedPage from "../../src/pages/auth/unconfirmed.astro";
import AuthVerifiedPage from "../../src/pages/auth/verified.astro";
import DashboardPage from "../../src/pages/dashboard.astro";
import IndexPage from "../../src/pages/index.astro";
import ProfilePage from "../../src/pages/profile.astro";
import SignInPage from "../../src/pages/signin.astro";
import { adminClient } from "../setup";
import { createAuthenticatedCookies, createTestUser } from "../utils";

const TEST_PASSWORD = "TestPassword123!";

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

describe("Page routes render without unexpected logs", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("renders the landing page", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(IndexPage, {
			request: buildRequest("/"),
		});

		expect(response.status).toBe(200);
	});

	it("renders the sign-in page when unauthenticated", async () => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(SignInPage, {
			request: buildRequest("/signin"),
		});

		expect(response.status).toBe(200);
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
			const { error: userStocksError } = await adminClient
				.from("user_stocks")
				.delete()
				.eq("user_id", user.id);
			if (userStocksError) {
				rootLogger.warn("Cleanup failed (user_stocks)", {
					error: userStocksError,
				});
			}
			const { error: userRowError } = await adminClient
				.from("users")
				.delete()
				.eq("id", user.id);
			if (userRowError) {
				rootLogger.warn("Cleanup failed (users)", { error: userRowError });
			}
			const { error: authDeleteError } =
				await adminClient.auth.admin.deleteUser(user.id);
			if (authDeleteError) {
				rootLogger.warn("Cleanup failed (auth)", { error: authDeleteError });
			}
		}
	}

	it("redirects from sign-in when authenticated", async () => {
		await withTestUser(
			{
				email: `test-${randomUUID()}@resend.dev`,
				password: TEST_PASSWORD,
				confirmed: true,
			},
			async (_user, cookies) => {
				const container = await AstroContainer.create({ renderers });
				const response = await container.renderToResponse(SignInPage, {
					request: buildRequest("/signin", cookies),
				});

				expect(response.status).toBe(302);
				expect(response.headers.get("Location")).toBe("/dashboard");
			},
		);
	});

	const authPages = [
		{ component: AuthRegisterPage, path: "/auth/register" },
		{ component: AuthForgotPage, path: "/auth/forgot" },
		{ component: AuthRecoverPage, path: "/auth/recover" },
		{ component: AuthUnconfirmedPage, path: "/auth/unconfirmed" },
	];

	it.each(authPages)("renders auth page $path", async ({ component, path }) => {
		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(component, {
			request: buildRequest(path),
		});

		expect(response.status).toBe(200);
	});

	it("renders verified page for authenticated user", async () => {
		await withTestUser(
			{
				email: `test-${randomUUID()}@resend.dev`,
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

	it("renders dashboard and profile for authenticated users", async () => {
		await withTestUser(
			{
				email: `test-${randomUUID()}@resend.dev`,
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

				const profileResponse = await container.renderToResponse(ProfilePage, {
					request: buildRequest("/profile", cookies),
				});
				expect(profileResponse.status).toBe(200);
			},
		);
	});
});
