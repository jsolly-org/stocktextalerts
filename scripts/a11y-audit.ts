/**
 * Accessibility audit script — runs Lighthouse + axe-core against all pages.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/a11y-audit.ts
 *
 * Expects a dev server running on http://localhost:4322 and Supabase running locally.
 * Outputs a11y-report.md with Lighthouse scores and axe violations.
 * Exits 0 even with violations (the nightly agent handles fixes).
 */

import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { TEST_PASSWORD } from "../tests/helpers/constants";
import { createAuthenticatedCookies } from "../tests/helpers/test-env";
import {
	cleanupTestUser,
	createTestEmail,
	createTestUser,
} from "../tests/helpers/test-user";

const BASE_URL = "http://localhost:4322";

const PUBLIC_ROUTES = [
	"/",
	"/about",
	"/contact",
	"/faq",
	"/privacy",
	"/terms",
	"/auth/signin",
	"/auth/register",
	"/auth/forgot",
];

const AUTHENTICATED_ROUTES = ["/dashboard", "/profile"];

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

async function runAxeOnPages(
	routes: string[],
	cookies?: Map<string, string>,
): Promise<PageAxeResult[]> {
	const browser = await chromium.launch();
	const context = await browser.newContext();

	if (cookies) {
		await context.addCookies([
			{
				name: "sb-access-token",
				value: cookies.get("sb-access-token") ?? "",
				url: BASE_URL,
			},
			{
				name: "sb-refresh-token",
				value: cookies.get("sb-refresh-token") ?? "",
				url: BASE_URL,
			},
		]);
	}

	const results: PageAxeResult[] = [];

	for (const route of routes) {
		const page = await context.newPage();
		try {
			await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle" });
			const axeResults = await new AxeBuilder({ page })
				.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
				.analyze();

			results.push({
				route,
				violations: axeResults.violations.map((v) => ({
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

async function runLighthouse(
	routes: string[],
): Promise<LighthouseScore[]> {
	// Dynamic imports — lighthouse and chrome-launcher are ESM-only
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

function buildReport(
	lighthouseScores: LighthouseScore[],
	axeResults: PageAxeResult[],
): string {
	const lines: string[] = [];
	lines.push("# Accessibility Audit Report");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
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

		// Group by rule ID
		const byRule = new Map<
			string,
			{ description: string; helpUrl: string; occurrences: { route: string; impact: string | undefined; html: string; failureSummary: string | undefined }[] }
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

	// Summary for quick check
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

async function main() {
	console.log("Starting accessibility audit...");
	let testUser: { id: string; email: string } | null = null;

	try {
		// Run Lighthouse on public routes
		console.log("Running Lighthouse on public routes...");
		const lighthouseScores = await runLighthouse(PUBLIC_ROUTES);

		// Run axe-core on public routes (no auth)
		console.log("Running axe-core on public routes...");
		const publicAxeResults = await runAxeOnPages(PUBLIC_ROUTES);

		// Create test user for authenticated routes
		console.log("Creating test user for authenticated routes...");
		const email = createTestEmail("a11y-audit");
		testUser = await createTestUser({
			email,
			password: TEST_PASSWORD,
			confirmed: true,
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		// Run axe-core on authenticated routes
		console.log("Running axe-core on authenticated routes...");
		const authAxeResults = await runAxeOnPages(
			AUTHENTICATED_ROUTES,
			cookies,
		);

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
	} finally {
		if (testUser) {
			try {
				console.log("Cleaning up test user...");
				await cleanupTestUser(testUser.id);
			} catch (error) {
				console.error("Test user cleanup failed:", error);
			}
		}
	}
}

main().catch((error) => {
	console.error("Audit failed:", error);
	// Exit 0 — the agent handles fixes, not the script exit code
});
