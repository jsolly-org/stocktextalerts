/**
 * Accessibility audit script — runs Lighthouse + axe-core against all pages.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/a11y-audit.ts
 *
 * Runs against a Vercel deployment (AUDIT_BASE_URL) or falls back to localhost:4322.
 * Uses VERCEL_AUTOMATION_BYPASS_SECRET to bypass Deployment Protection.
 * Authenticates with AUDIT_TEST_EMAIL + DEFAULT_PASSWORD for protected routes
 * (skipped if either env var is missing).
 * Outputs a11y-report.md with Lighthouse scores and axe violations.
 * Exits 0 even with violations (the nightly agent handles fixes).
 */

import { readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const BASE_URL = (process.env.AUDIT_BASE_URL || "http://localhost:4322").replace(
	/\/$/,
	"",
);

const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders: Record<string, string> = BYPASS_SECRET
	? {
			"x-vercel-protection-bypass": BYPASS_SECRET,
			"x-vercel-set-bypass-cookie": "true",
		}
	: {};

const AUTH_ROUTE_PREFIXES = ["/dashboard", "/profile"];

const ROUTES_DIR = path.join(process.cwd(), "src", "pages");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type AxeViolation = {
	id: string;
	impact: string | undefined;
	description: string;
	helpUrl: string;
	nodes: { html: string; failureSummary: string | undefined }[];
};

type PageAxeResult = {
	route: string;
	violations: AxeViolation[];
};

type LighthouseScore = {
	route: string;
	accessibility: number | null;
};

/* ------------------------------------------------------------------ */
/*  Route discovery                                                    */
/* ------------------------------------------------------------------ */

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

async function discoverRoutes(): Promise<{
	publicRoutes: string[];
	authenticatedRoutes: string[];
}> {
	const files = await walk(ROUTES_DIR);
	const allRoutes = files
		.map(routeFromFile)
		.filter((route): route is string => Boolean(route))
		.filter((route) => route !== "/404" && route !== "/500");

	const unique = [...new Set(allRoutes)].sort();

	const publicRoutes: string[] = [];
	const authenticatedRoutes: string[] = [];

	for (const route of unique) {
		if (AUTH_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix))) {
			authenticatedRoutes.push(route);
		} else {
			publicRoutes.push(route);
		}
	}

	return { publicRoutes, authenticatedRoutes };
}

/* ------------------------------------------------------------------ */
/*  axe-core                                                           */
/* ------------------------------------------------------------------ */

async function runAxeOnPages(
	routes: string[],
	cookies?: { name: string; value: string; domain: string; path: string }[],
): Promise<PageAxeResult[]> {
	const browser = await chromium.launch();
	const context = await browser.newContext({
		extraHTTPHeaders: bypassHeaders,
	});

	if (cookies) {
		await context.addCookies(cookies);
	}

	const results: PageAxeResult[] = [];

	for (const route of routes) {
		const page = await context.newPage();
		try {
			await page.goto(`${BASE_URL}${route}`, {
				waitUntil: "networkidle",
			});
			const axeRes = await new AxeBuilder({ page })
				.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
				.analyze();

			results.push({
				route,
				violations: axeRes.violations.map((v) => ({
					id: v.id,
					impact: v.impact ?? undefined,
					description: v.description,
					helpUrl: v.helpUrl,
					nodes: v.nodes.map((n) => ({
						html: n.html,
						failureSummary: n.failureSummary ?? undefined,
					})),
				})),
			});
		} catch (error) {
			console.error(`axe-core failed on ${route}:`, error);
			results.push({ route, violations: [] });
		} finally {
			await page.close();
		}
	}

	await context.close();
	await browser.close();
	return results;
}

/* ------------------------------------------------------------------ */
/*  Lighthouse                                                         */
/* ------------------------------------------------------------------ */

async function runLighthouse(routes: string[]): Promise<LighthouseScore[]> {
	const lighthouse = (await import("lighthouse")).default;
	const { launch } = await import("chrome-launcher");
	const scores: LighthouseScore[] = [];

	const chrome = await launch({
		chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
	});

	try {
		for (const route of routes) {
			try {
				const result = await lighthouse(`${BASE_URL}${route}`, {
					port: chrome.port,
					output: "json",
					onlyCategories: ["accessibility"],
					logLevel: "error",
					extraHeaders: bypassHeaders,
				});

				const score =
					result?.lhr?.categories?.accessibility?.score ?? null;
				scores.push({
					route,
					accessibility:
						score !== null ? Math.round(score * 100) : null,
				});
			} catch (error) {
				console.error(`Lighthouse failed on ${route}:`, error);
				scores.push({ route, accessibility: null });
			}
		}
	} finally {
		await chrome.kill();
	}

	return scores;
}

/* ------------------------------------------------------------------ */
/*  Report builder                                                     */
/* ------------------------------------------------------------------ */

function buildReport(
	lighthouseScores: LighthouseScore[],
	axeResults: PageAxeResult[],
): string {
	const lines: string[] = [];
	lines.push("# Accessibility Audit Report");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push(`Target: ${BASE_URL}`);
	lines.push("");

	// Lighthouse scores table
	lines.push("## Lighthouse Accessibility Scores");
	lines.push("");
	lines.push("| Route | Score |");
	lines.push("|-------|-------|");
	for (const { route, accessibility } of lighthouseScores) {
		const scoreStr =
			accessibility !== null ? `${accessibility}/100` : "Error";
		lines.push(`| ${route} | ${scoreStr} |`);
	}
	lines.push("");

	// axe-core violations
	const allViolations = axeResults.flatMap((r) =>
		r.violations.map((v) => ({ route: r.route, ...v })),
	);

	if (allViolations.length === 0) {
		lines.push("## axe-core Violations");
		lines.push("");
		lines.push("No WCAG 2.1 AA violations detected.");
		lines.push("");
	} else {
		lines.push(`## axe-core Violations (${allViolations.length} total)`);
		lines.push("");

		const byRule = new Map<
			string,
			{
				description: string;
				helpUrl: string;
				occurrences: {
					route: string;
					impact: string | undefined;
					html: string;
					failureSummary: string | undefined;
				}[];
			}
		>();
		for (const v of allViolations) {
			for (const node of v.nodes) {
				const existing = byRule.get(v.id);
				if (existing) {
					existing.occurrences.push({
						route: v.route,
						impact: v.impact,
						html: node.html,
						failureSummary: node.failureSummary,
					});
				} else {
					byRule.set(v.id, {
						description: v.description,
						helpUrl: v.helpUrl,
						occurrences: [
							{
								route: v.route,
								impact: v.impact,
								html: node.html,
								failureSummary: node.failureSummary,
							},
						],
					});
				}
			}
		}

		for (const [ruleId, data] of Array.from(byRule)) {
			lines.push(`### ${ruleId}`);
			lines.push("");
			lines.push(`${data.description} ([docs](${data.helpUrl}))`);
			lines.push("");
			for (const occ of data.occurrences) {
				lines.push(
					`- **${occ.route}** (${occ.impact ?? "unknown"}): \`${occ.html}\``,
				);
				if (occ.failureSummary) {
					lines.push(`  - ${occ.failureSummary}`);
				}
			}
			lines.push("");
		}
	}

	// Summary
	const hasViolations = allViolations.length > 0;
	const failingScores = lighthouseScores.filter(
		(s) => s.accessibility !== null && s.accessibility < 90,
	);
	lines.push("## Summary");
	lines.push("");
	lines.push(`- axe-core violations: ${allViolations.length}`);
	lines.push(
		`- Lighthouse scores below 90: ${failingScores.length}${failingScores.length > 0 ? ` (${failingScores.map((s) => `${s.route}: ${s.accessibility}`).join(", ")})` : ""}`,
	);
	lines.push(
		`- Action needed: ${hasViolations || failingScores.length > 0 ? "yes" : "no"}`,
	);
	lines.push("");

	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Authentication (via UI sign-in form)                               */
/* ------------------------------------------------------------------ */

async function signInViaUI(): Promise<
	{ name: string; value: string; domain: string; path: string }[] | null
> {
	// AUDIT_TEST_EMAIL must be set explicitly. The hardcoded default was
	// removed on 2026-04-11 to keep real test-account addresses out of
	// checked-in code — the only place that address is allowed is a
	// one-line note in AGENTS.md#dev-environment describing the prod
	// dev-login account.
	const testEmail = process.env.AUDIT_TEST_EMAIL;
	const testPassword = process.env.DEFAULT_PASSWORD;

	if (!testEmail || !testPassword) {
		console.log(
			"Skipping authenticated routes (AUDIT_TEST_EMAIL or DEFAULT_PASSWORD not set).",
		);
		return null;
	}

	const browser = await chromium.launch();
	const context = await browser.newContext({
		extraHTTPHeaders: bypassHeaders,
	});
	const page = await context.newPage();

	try {
		await page.goto(`${BASE_URL}/auth/signin`, {
			waitUntil: "networkidle",
		});
		await page.fill('input[name="email"]', testEmail);
		await page.fill('input[name="password"]', testPassword);
		await page.click('button[type="submit"]');
		await page.waitForURL("**/dashboard", { timeout: 15000 });

		const cookies = await context.cookies(BASE_URL);
		const authCookies = cookies
			.filter((c) => c.name.startsWith("sb-"))
			.map((c) => ({
				name: c.name,
				value: c.value,
				domain: c.domain,
				path: c.path,
			}));

		if (authCookies.length === 0) {
			console.error("Sign-in succeeded but no sb-* cookies found.");
			return null;
		}

		return authCookies;
	} catch (error) {
		console.error("UI sign-in failed:", error);
		return null;
	} finally {
		await context.close();
		await browser.close();
	}
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
	console.log(`Starting accessibility audit against ${BASE_URL}...`);

	// Discover routes from src/pages
	const { publicRoutes, authenticatedRoutes } = await discoverRoutes();
	console.log(
		`Discovered ${publicRoutes.length} public and ${authenticatedRoutes.length} authenticated routes.`,
	);

	// Run Lighthouse on public routes
	console.log("Running Lighthouse on public routes...");
	const lighthouseScores = await runLighthouse(publicRoutes);

	// Run axe-core on public routes (no auth)
	console.log("Running axe-core on public routes...");
	const publicAxeResults = await runAxeOnPages(publicRoutes);

	// Authenticate via UI and run axe-core on authenticated routes
	let authAxeResults: PageAxeResult[] = [];
	const cookies = await signInViaUI();
	if (cookies && authenticatedRoutes.length > 0) {
		console.log("Running axe-core on authenticated routes...");
		authAxeResults = await runAxeOnPages(authenticatedRoutes, cookies);
	}

	const allAxeResults = [...publicAxeResults, ...authAxeResults];

	// Build and write report
	const report = buildReport(lighthouseScores, allAxeResults);
	writeFileSync("a11y-report.md", report);
	console.log("Report written to a11y-report.md");

	// Print summary
	const totalViolations = allAxeResults.reduce(
		(sum, r) => sum + r.violations.length,
		0,
	);
	console.log(`Total axe violations: ${totalViolations}`);
	console.log(
		`Lighthouse scores: ${lighthouseScores.map((s) => `${s.route}=${s.accessibility ?? "error"}`).join(", ")}`,
	);
}

main().catch((error) => {
	console.error("Audit failed:", error);
	// Exit 0 — the agent handles fixes, not the script exit code
});
