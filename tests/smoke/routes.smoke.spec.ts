import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "@playwright/test";
import { TEST_PASSWORD } from "../helpers/constants";
import { createAuthenticatedCookies } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

const ROUTES_DIR = path.join(process.cwd(), "src", "pages");
const CONSOLE_ALLOWLIST: Array<string | RegExp> = [];

type ConsoleIssue = {
	route: string;
	type: "warning" | "error" | "pageerror";
	message: string;
};

function isAllowedConsoleMessage(message: string): boolean {
	return CONSOLE_ALLOWLIST.some((pattern) =>
		typeof pattern === "string" ? pattern === message : pattern.test(message),
	);
}

function shouldSkipSegment(segment: string): boolean {
	return segment.startsWith("_") || segment.includes("[");
}

function routeFromFile(filePath: string): string | null {
	const relative = path.relative(ROUTES_DIR, filePath);
	const parts = relative.split(path.sep);

	if (parts[0] === "api") return null;
	if (parts.some((part) => shouldSkipSegment(part))) return null;
	if (!relative.endsWith(".astro")) return null;

	const withoutExt = relative.replace(/\.astro$/, "");
	const normalized = withoutExt.replace(/\\/g, "/");

	if (normalized === "index") return "/";
	if (normalized.endsWith("/index")) {
		const base = normalized.slice(0, -"/index".length);
		return base.length === 0 ? "/" : `/${base}`;
	}

	return `/${normalized}`;
}

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const results: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await walk(fullPath)));
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}

	return results;
}

async function collectRoutes(): Promise<string[]> {
	const files = await walk(ROUTES_DIR);
	const routes = files
		.map(routeFromFile)
		.filter((route): route is string => Boolean(route))
		.filter((route) => route !== "/404" && route !== "/500");

	return [...new Set(routes)].sort();
}

test("A signed-in user can navigate all routes without console errors.", async ({
	page,
}) => {
	let testUser: { id: string; email: string } | null = null;
	let caughtError: unknown = null;
	let cleanupError: Error | null = null;

	try {
		testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		// Warm up the dev server and extract baseOrigin. Use networkidle to
		// ensure Vite has finished optimizing deps before we start checking
		// for console errors.
		await page.goto("/", { waitUntil: "networkidle" });
		const baseOrigin = new URL(page.url()).origin;

		const consoleIssues: ConsoleIssue[] = [];
		let activeRoute = "";

		page.on("console", (message) => {
			const type = message.type();
			if (type !== "warning" && type !== "error") {
				return;
			}

			const text = message.text();
			if (!isAllowedConsoleMessage(text)) {
				consoleIssues.push({
					route: activeRoute,
					type,
					message: text,
				});
			}
		});

		page.on("pageerror", (error) => {
			const text = error?.message ?? String(error);
			if (!isAllowedConsoleMessage(text)) {
				consoleIssues.push({
					route: activeRoute,
					type: "pageerror",
					message: text,
				});
			}
		});

		page.on("response", (response) => {
			if (response.status() !== 404) {
				return;
			}
			const url = response.url();
			if (!url.startsWith(baseOrigin)) {
				return;
			}
			consoleIssues.push({
				route: activeRoute,
				type: "error",
				message: `404: ${url}`,
			});
		});

		activeRoute = "/auth/signin";
		const loginIssuesBefore = consoleIssues.length;
		await page.goto("/auth/signin", { waitUntil: "domcontentloaded" });

		if (consoleIssues.length > loginIssuesBefore) {
			const newIssues = consoleIssues
				.slice(loginIssuesBefore)
				.map(
					(issue) =>
						`${issue.type.toUpperCase()}: ${issue.message} (route: ${issue.route || "unknown"})`,
				);
			throw new Error(
				`Unexpected console output on /auth/signin: ${newIssues.join("; ")}`,
			);
		}

		const authCookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);
		await page.context().addCookies([
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

		const routes = await collectRoutes();

		for (const route of routes) {
			activeRoute = route;
			const issuesBefore = consoleIssues.length;
			const response = await page.goto(route, {
				waitUntil: "domcontentloaded",
			});

			const status = response?.status() ?? 0;
			if (status >= 400) {
				throw new Error(`Route ${route} returned status ${status}`);
			}

			const finalUrl = new URL(page.url());
			const finalPath = finalUrl.pathname;
			const isSigninRedirect =
				route === "/auth/signin" && finalPath === "/dashboard";
			const isRegisterGateRedirect =
				route === "/auth/register" &&
				(finalPath === "/auth/signin" || finalPath === "/dashboard");
			if (!isSigninRedirect && !isRegisterGateRedirect && finalPath !== route) {
				throw new Error(`Route ${route} redirected to ${finalPath}`);
			}

			if (consoleIssues.length > issuesBefore) {
				const newIssues = consoleIssues
					.slice(issuesBefore)
					.map(
						(issue) =>
							`${issue.type.toUpperCase()}: ${issue.message} (route: ${issue.route || "unknown"})`,
					);
				throw new Error(
					`Unexpected console output on ${route}: ${newIssues.join("; ")}`,
				);
			}
		}
	} catch (error) {
		caughtError = error;
	} finally {
		if (testUser) {
			try {
				await cleanupTestUser(testUser.id);
			} catch (error) {
				cleanupError = error as Error;
			}
		}
	}

	if (cleanupError) {
		if (caughtError) {
			const caughtMessage =
				caughtError instanceof Error
					? caughtError.message
					: String(caughtError);
			throw new Error(`${caughtMessage}; ${cleanupError.message}`, {
				cause: caughtError,
			});
		}
		throw cleanupError;
	}

	if (caughtError) {
		throw caughtError;
	}
});
